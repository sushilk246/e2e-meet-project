"""
WebSocket signaling consumer for a single meeting room.

Route: ws://.../ws/room/<code>/

Inbound (from a peer's browser):
    {type: "signal-offer",  to: <peer_id>, sdp: ...}    relayed to one peer
    {type: "signal-answer", to: <peer_id>, sdp: ...}    relayed to one peer
    {type: "signal-ice",    to: <peer_id>, candidate}   relayed to one peer
    {type: "chat-message",  body: "..."}                persisted (if logged-in)
                                                          + broadcast
    {type: "peer-state",    audio: bool, video: bool}   updates the sender's
                                                          mic/cam state in the
                                                          room roster + broadcast
    {type: "admit",         peer_id}                    host-only: accept knocker
    {type: "deny",          peer_id}                    host-only: reject knocker

Outbound (server → browser):
    {type: "hello",       peer_id}                                 sent once on connect
    {type: "roster",      peers: [{peer_id, name, audio, video}]}  sent once on admit —
                                                                    snapshot of peers
                                                                    already in the room
                                                                    (excludes the newcomer)
    {type: "peer-joined", peer_id, name}                broadcast on join
    {type: "peer-left",   peer_id}                      broadcast on disconnect
    {type: "peer-state",  peer_id, audio, video}        broadcast when a peer toggles
                                                          mic or camera (sender excluded)
    {type: "chat-broadcast", author, body, ts}          broadcast to whole room
    {type: "room-closed"}                               broadcast when host ends
                                                          the meeting; socket
                                                          closes with 4005
    {type: "knock",         peer_id, name}              host-only: someone wants in
    {type: "pending-knocks", knocks:[{peer_id,name}]}   host-only: flushed on (re)connect
    {type: "knock-cancelled", peer_id}                  host-only: knocker gave up
    {type: "admitted"}                                  pending → admitted; the
                                                          client should now run the
                                                          normal join sequence
    {type: "signal-offer" | "signal-answer" | "signal-ice",
     from, ...payload}                                   relayed

Phase 13 access model:
    Every non-host joiner enters a "pending" state and a knock is routed to
    the host. The host responds with `admit` or `deny`. Pending peers receive
    no roster/peer-joined/peer-left/peer-state/chat traffic — they're not
    members of the meeting yet. If no host is in the room when someone tries
    to join, the connection is rejected immediately with close code 4007;
    knocks are never queued for an absent host.

Close codes:
    4001 — unauthenticated (no logged-in user and no guest name in session)
    4004 — room not found / inactive
    4005 — room ended by host
    4007 — host unavailable (private room, host not in roster)
    4008 — host denied this knocker
"""

import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone

from .models import Message, Participation, Room


RELAY_TYPES = {"signal-offer", "signal-answer", "signal-ice"}
CHAT_BODY_MAX = 2000  # generous; messages above this are clipped

# Per-process in-memory state. Single-Daphne deployments only; for multi-worker
# scale these would move into Redis (e.g. per-room hashes keyed by peer_id).
#
#   _room_roster["abc123"] = {
#       "<peer_id>": {
#           "name":    "<username|guest>",
#           "audio":   True,
#           "video":   True,
#           "is_host": False,
#           "channel": "<channels channel_name — needed for targeted sends>",
#       },
#       ...
#   }
#
# `_room_pending` holds knockers waiting for admit. Same key shape but only
# `name` + `channel` are stored; they have no audio/video/role until admitted.
_room_roster: dict[str, dict[str, dict]] = {}
_room_pending: dict[str, dict[str, dict]] = {}


class SignalingConsumer(AsyncJsonWebsocketConsumer):

    async def connect(self):
        self.code = self.scope["url_route"]["kwargs"]["code"]

        # Identity: prefer authenticated Django user; otherwise read the
        # per-room guest name stashed in session by the guest_landing flow.
        user = self.scope["user"]
        if user.is_authenticated:
            self.display_name = user.username
            self.user_id = user.id
            self.is_guest = False
        else:
            session = self.scope.get("session")
            guest_name = ""
            if session is not None:
                guest_name = (session.get(f"guest_name_{self.code}") or "").strip()
            if not guest_name:
                await self.close(code=4001)
                return
            self.display_name = guest_name
            self.user_id = None
            self.is_guest = True

        room = await self._get_room(self.code)
        if room is None:
            await self.close(code=4004)
            return

        # Guests can never be host. Only an authenticated user whose id matches
        # room.host_id is the host.
        self.is_host = (not self.is_guest) and (room.host_id == self.user_id)
        self.peer_id = str(uuid.uuid4())
        self.group = f"room_{self.code}"
        self.is_pending = False  # flipped on below for non-host knockers

        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

        # Tell this peer its own id (used as `from` in WebRTC signaling).
        await self.send_json({"type": "hello", "peer_id": self.peer_id})

        if self.is_host:
            # Host walks straight in. Their own connect is also how they pick up
            # any pending knocks that arrived during a refresh / brief offline.
            await self._admit_self()
            await self._flush_pending_knocks()
            return

        # Non-host: must knock. Find the host's roster entry so we can route the
        # knock notification only to them.
        host_entry = self._find_host_entry()
        if host_entry is None:
            # No host in the room → reject immediately. We do not queue knocks
            # for an absent host; the design choice is honest UX ("host
            # unavailable") over a hanging spinner.
            await self.close(code=4007)
            return

        self.is_pending = True
        _room_pending.setdefault(self.code, {})[self.peer_id] = {
            "name": self.display_name,
            "channel": self.channel_name,
        }
        await self.channel_layer.send(
            host_entry["channel"],
            {
                "type": "knock.notify",
                "peer_id": self.peer_id,
                "name": self.display_name,
            },
        )

    async def disconnect(self, code):
        if not getattr(self, "peer_id", None):
            return  # never finished connect

        if getattr(self, "is_pending", False):
            # Knocker gave up before host responded — drop from pending and tell
            # the host so the knock card disappears.
            pending = _room_pending.get(self.code, {})
            pending.pop(self.peer_id, None)
            if not pending:
                _room_pending.pop(self.code, None)
            host_entry = self._find_host_entry()
            if host_entry is not None:
                await self.channel_layer.send(
                    host_entry["channel"],
                    {"type": "knock.cancelled", "peer_id": self.peer_id},
                )
        else:
            # Full participant left — remove from roster, notify the group.
            room_map = _room_roster.get(self.code)
            if room_map:
                room_map.pop(self.peer_id, None)
                if not room_map:
                    _room_roster.pop(self.code, None)
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

        # Host-only admit/deny — checked before the pending-peer gate because
        # the host themselves is never pending.
        if msg_type in ("admit", "deny"):
            if not self.is_host:
                return
            target = content.get("peer_id")
            if not target:
                return
            if msg_type == "admit":
                await self._admit_peer(target)
            else:
                await self._deny_peer(target)
            return

        # Pending peers can't send anything else — they're not participants yet.
        if self.is_pending:
            return

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
            # Logged-in users persist; guests broadcast ephemerally (Message
            # FK requires a real User, and we keep the model simple in v1).
            if self.is_guest:
                ts = timezone.now().isoformat()
            else:
                ts = await self._save_message(body)
            await self.channel_layer.group_send(
                self.group,
                {
                    "type": "chat.broadcast",
                    "author": self.display_name,
                    "body": body,
                    "ts": ts,
                },
            )

        elif msg_type == "peer-state":
            audio = bool(content.get("audio", True))
            video = bool(content.get("video", True))
            room_map = _room_roster.get(self.code)
            if room_map and self.peer_id in room_map:
                room_map[self.peer_id]["audio"] = audio
                room_map[self.peer_id]["video"] = video
            await self.channel_layer.group_send(
                self.group,
                {
                    "type": "peer.state",
                    "peer_id": self.peer_id,
                    "audio": audio,
                    "video": video,
                    "sender_channel": self.channel_name,
                },
            )

    # ----- pending → admitted transitions -----

    async def _admit_self(self):
        """Add `self` to the roster and broadcast peer-joined.

        Called from two places: (1) the host's own connect, (2) a previously
        pending peer's `knock.admitted` handler. The flow is identical — send
        the roster snapshot first (so the newcomer doesn't see themselves),
        then add self, then notify everyone else.
        """
        existing = _room_roster.get(self.code, {})
        await self.send_json({
            "type": "roster",
            "peers": [
                {
                    "peer_id": pid,
                    "name": data["name"],
                    "audio": data["audio"],
                    "video": data["video"],
                }
                for pid, data in existing.items()
            ],
        })
        _room_roster.setdefault(self.code, {})[self.peer_id] = {
            "name": self.display_name,
            "audio": True,
            "video": True,
            "is_host": self.is_host,
            "channel": self.channel_name,
        }
        await self._record_participation()
        await self.channel_layer.group_send(
            self.group,
            {
                "type": "peer.joined",
                "peer_id": self.peer_id,
                "name": self.display_name,
                "sender_channel": self.channel_name,
            },
        )

    async def _admit_peer(self, peer_id):
        """Host clicked Admit on a knocker — tell the knocker's consumer."""
        pending = _room_pending.get(self.code, {})
        entry = pending.pop(peer_id, None)
        if entry is None:
            return
        if not pending:
            _room_pending.pop(self.code, None)
        await self.channel_layer.send(
            entry["channel"],
            {"type": "knock.admitted"},
        )

    async def _deny_peer(self, peer_id):
        pending = _room_pending.get(self.code, {})
        entry = pending.pop(peer_id, None)
        if entry is None:
            return
        if not pending:
            _room_pending.pop(self.code, None)
        await self.channel_layer.send(
            entry["channel"],
            {"type": "knock.denied"},
        )

    async def _flush_pending_knocks(self):
        # On host (re)connect: surface any knocks that piled up while another
        # host tab was still present. Knocks are NEVER queued when no host is
        # in the room (we reject with 4007 in that case), so this is normally
        # a no-op unless a host has multiple tabs open.
        pending = _room_pending.get(self.code, {})
        if not pending:
            return
        await self.send_json({
            "type": "pending-knocks",
            "knocks": [
                {"peer_id": pid, "name": data["name"]}
                for pid, data in pending.items()
            ],
        })

    def _find_host_entry(self):
        room_map = _room_roster.get(self.code, {})
        for entry in room_map.values():
            if entry.get("is_host"):
                return entry
        return None

    # ----- group-event handlers -----

    async def knock_notify(self, event):
        # channel_layer.send → only the host's channel sees this.
        await self.send_json({
            "type": "knock",
            "peer_id": event["peer_id"],
            "name": event["name"],
        })

    async def knock_cancelled(self, event):
        await self.send_json({
            "type": "knock-cancelled",
            "peer_id": event["peer_id"],
        })

    async def knock_admitted(self, event):
        # Sent to a pending peer's channel when the host clicks Admit.
        # Flip out of pending state and run the normal join flow.
        self.is_pending = False
        await self.send_json({"type": "admitted"})
        await self._admit_self()

    async def knock_denied(self, event):
        await self.close(code=4008)

    async def peer_joined(self, event):
        if event["sender_channel"] == self.channel_name:
            return
        if self.is_pending:
            return
        await self.send_json({
            "type": "peer-joined",
            "peer_id": event["peer_id"],
            "name": event["name"],
        })

    async def peer_left(self, event):
        if event["sender_channel"] == self.channel_name:
            return
        if self.is_pending:
            return
        await self.send_json({
            "type": "peer-left",
            "peer_id": event["peer_id"],
        })

    async def peer_state(self, event):
        if event["sender_channel"] == self.channel_name:
            return
        if self.is_pending:
            return
        await self.send_json({
            "type": "peer-state",
            "peer_id": event["peer_id"],
            "audio": event["audio"],
            "video": event["video"],
        })

    async def signal_relay(self, event):
        if event["to"] != self.peer_id:
            return
        if self.is_pending:
            return
        await self.send_json({
            "type": event["msg_type"],
            "from": event["from_peer"],
            **event["payload"],
        })

    async def chat_broadcast(self, event):
        if self.is_pending:
            return
        await self.send_json({
            "type": "chat-broadcast",
            "author": event["author"],
            "body": event["body"],
            "ts": event["ts"],
        })

    async def room_closed(self, event):
        # Host ended the meeting — pending peers get told too, so they exit the
        # "Waiting…" overlay cleanly instead of seeing 4007 on their next move.
        await self.send_json({"type": "room-closed"})
        await self.close(code=4005)

    # ----- DB helpers -----

    @database_sync_to_async
    def _get_room(self, code):
        return Room.objects.filter(code=code, is_active=True).first()

    @database_sync_to_async
    def _save_message(self, body):
        room = Room.objects.get(code=self.code)
        msg = Message.objects.create(room=room, author_id=self.user_id, body=body)
        return msg.created_at.isoformat()

    async def _record_participation(self):
        if self.is_guest:
            # Guest participation isn't surfaced anywhere in v1 (dashboard is
            # logged-in only). Skip the write — keep the table noise-free.
            return
        await self._record_participation_db()

    @database_sync_to_async
    def _record_participation_db(self):
        room = Room.objects.filter(code=self.code).first()
        if room is None:
            return
        Participation.objects.get_or_create(room=room, user_id=self.user_id)
