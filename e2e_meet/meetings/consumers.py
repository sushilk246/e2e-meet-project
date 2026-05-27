"""
WebSocket signaling consumer for a single meeting room.

Route: ws://.../ws/room/<code>/

Inbound (from a peer's browser):
    {type: "signal-offer",  to: <peer_id>, sdp: ...}    relayed to one peer
    {type: "signal-answer", to: <peer_id>, sdp: ...}    relayed to one peer
    {type: "signal-ice",    to: <peer_id>, candidate}   relayed to one peer
    {type: "chat-message",  body: "..."}                persisted + broadcast

Outbound (server → browser):
    {type: "hello",       peer_id}                      sent once on connect
    {type: "peer-joined", peer_id, name}                broadcast on join
    {type: "peer-left",   peer_id}                      broadcast on disconnect
    {type: "chat-broadcast", author, body, ts}          broadcast to whole room
    {type: "signal-offer" | "signal-answer" | "signal-ice",
     from, ...payload}                                   relayed

Targeted relay: signal-* events go to the whole group but only the consumer
whose peer_id matches `to` forwards to its socket. Chat broadcasts go to
everyone in the room group (including the sender, so they see their own
message appear).

Close codes:
    4001 — unauthenticated
    4004 — room not found / inactive
"""

import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .models import Message, Room


RELAY_TYPES = {"signal-offer", "signal-answer", "signal-ice"}
CHAT_BODY_MAX = 2000  # generous; messages above this are clipped


class SignalingConsumer(AsyncJsonWebsocketConsumer):

    async def connect(self):
        self.user = self.scope["user"]
        if not self.user.is_authenticated:
            await self.close(code=4001)
            return

        self.code = self.scope["url_route"]["kwargs"]["code"]
        if not await self._room_exists(self.code):
            await self.close(code=4004)
            return

        # Per-connection identity. Two tabs as the same user get distinct ids.
        self.peer_id = str(uuid.uuid4())
        self.group = f"room_{self.code}"

        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

        # Tell this peer its own id (Phase 7 needs it for signaling `from`).
        await self.send_json({"type": "hello", "peer_id": self.peer_id})

        # Notify existing peers that someone joined.
        await self.channel_layer.group_send(
            self.group,
            {
                "type": "peer.joined",
                "peer_id": self.peer_id,
                "name": self.user.username,
                "sender_channel": self.channel_name,
            },
        )

    async def disconnect(self, code):
        if not getattr(self, "peer_id", None):
            return  # never fully connected
        await self.channel_layer.group_send(
            self.group,
            {
                "type": "peer.left",
                "peer_id": self.peer_id,
                "sender_channel": self.channel_name,
            },
        )
        await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content):
        msg_type = content.get("type")

        if msg_type in RELAY_TYPES:
            target = content.get("to")
            if not target:
                return
            payload = {k: v for k, v in content.items() if k not in ("type", "to")}
            await self.channel_layer.group_send(
                self.group,
                {
                    "type": "signal.relay",
                    "msg_type": msg_type,
                    "from_peer": self.peer_id,
                    "to": target,
                    "payload": payload,
                },
            )

        elif msg_type == "chat-message":
            body = (content.get("body") or "").strip()
            if not body:
                return
            body = body[:CHAT_BODY_MAX]
            msg = await self._save_message(body)
            await self.channel_layer.group_send(
                self.group,
                {
                    "type": "chat.broadcast",
                    "author": self.user.username,
                    "body": msg.body,
                    "ts": msg.created_at.isoformat(),
                },
            )

    # ----- group-event handlers -----

    async def peer_joined(self, event):
        if event["sender_channel"] == self.channel_name:
            return  # never tell the newcomer about themselves
        await self.send_json({
            "type": "peer-joined",
            "peer_id": event["peer_id"],
            "name": event["name"],
        })

    async def peer_left(self, event):
        if event["sender_channel"] == self.channel_name:
            return
        await self.send_json({
            "type": "peer-left",
            "peer_id": event["peer_id"],
        })

    async def signal_relay(self, event):
        if event["to"] != self.peer_id:
            return
        await self.send_json({
            "type": event["msg_type"],
            "from": event["from_peer"],
            **event["payload"],
        })

    async def chat_broadcast(self, event):
        await self.send_json({
            "type": "chat-broadcast",
            "author": event["author"],
            "body": event["body"],
            "ts": event["ts"],
        })

    # ----- helpers -----

    @database_sync_to_async
    def _room_exists(self, code):
        return Room.objects.filter(code=code, is_active=True).exists()

    @database_sync_to_async
    def _save_message(self, body):
        room = Room.objects.get(code=self.code)
        return Message.objects.create(room=room, author=self.user, body=body)
