/*
 * room.js — Phase 7 (WebRTC mesh).
 *
 * Modules:
 *   - chat-panel toggle           (Phase 4)
 *   - copy-code button             (Phase 4)
 *   - localMedia: getUserMedia, mic/cam/share, leave cleanup  (Phase 5)
 *   - signaling: WebSocket client  (Phase 6)
 *   - mesh: RTCPeerConnection per peer, SDP+ICE exchange, tile mgmt (Phase 7)
 *
 * Topology: full mesh. Each peer holds (N-1) RTCPeerConnections. Existing
 * peers initiate offers to newcomers (newcomer never sees peer-joined
 * for itself — server filters), so we avoid glare without negotiationneeded
 * dance.
 *
 * ICE: RTC_CONFIG is the project's single source of truth. To enable
 * cross-network calls, swap iceServers to [{urls: "stun:stun.l.google.com:19302"}].
 */

const RTC_CONFIG = {
    iceServers: [
        // STUN — fast direct path when the network allows it.
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.relay.metered.ca:80" },
        // Metered TURN relay (keyed) — relays media when direct P2P fails
        // (symmetric/strict NAT, corporate firewalls). The turns: 443 TLS entry
        // is the one that gets through DPI firewalls (looks like plain HTTPS).
        {
            urls: "turn:global.relay.metered.ca:80",
            username: "cc578ac920b66d2708697463",
            credential: "K78YxjgXS02BVxB/",
        },
        {
            urls: "turn:global.relay.metered.ca:80?transport=tcp",
            username: "cc578ac920b66d2708697463",
            credential: "K78YxjgXS02BVxB/",
        },
        {
            urls: "turn:global.relay.metered.ca:443",
            username: "cc578ac920b66d2708697463",
            credential: "K78YxjgXS02BVxB/",
        },
        {
            urls: "turns:global.relay.metered.ca:443?transport=tcp",
            username: "cc578ac920b66d2708697463",
            credential: "K78YxjgXS02BVxB/",
        },
    ],
};

/* -------------------------------------------------------------------------- */
/* Slide-in panel toggles (chat + people share the right rail; opening one    */
/* closes the other so they don't overlap on narrow viewports.)               */
/* -------------------------------------------------------------------------- */

const panels = (() => {
    const registry = [];

    function register(panelId, openBtnId, closeBtnId) {
        const panel = document.getElementById(panelId);
        const openBtn = document.getElementById(openBtnId);
        const closeBtn = document.getElementById(closeBtnId);
        if (!panel || !openBtn) return;

        function setOpen(open) {
            if (open) {
                // Close any sibling panel first.
                for (const other of registry) {
                    if (other.panel !== panel) other.setOpen(false);
                }
            }
            panel.classList.toggle("is-open", open);
            panel.setAttribute("aria-hidden", open ? "false" : "true");
            openBtn.setAttribute("data-state", open ? "on" : "off");
        }
        openBtn.addEventListener("click", () => setOpen(!panel.classList.contains("is-open")));
        if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));
        registry.push({ panel, setOpen });
    }
    return { register };
})();

panels.register("chat-panel",   "toggle-chat",   "chat-close");
panels.register("people-panel", "toggle-people", "people-close");

/* -------------------------------------------------------------------------- */
/* Copy room code                                                             */
/* -------------------------------------------------------------------------- */

(function initCopyCode() {
    const btn = document.getElementById("copy-code");
    if (!btn) return;
    btn.addEventListener("click", async () => {
        const code = btn.dataset.code;
        try {
            await navigator.clipboard.writeText(code);
            const original = btn.textContent;
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = original; }, 1200);
        } catch { /* clipboard blocked */ }
    });
})();

/* -------------------------------------------------------------------------- */
/* Local media: camera + mic + screen share                                   */
/* -------------------------------------------------------------------------- */

const localMedia = (() => {
    let cameraStream = null;
    let displayStream = null;
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });

    const els = {};

    async function start() {
        els.tile     = document.querySelector('.tile[data-peer="local"]');
        els.video    = els.tile?.querySelector(".tile-video");
        els.micBtn   = document.getElementById("toggle-mic");
        els.camBtn   = document.getElementById("toggle-cam");
        els.shareBtn = document.getElementById("toggle-share");
        els.micDot   = els.tile?.querySelector(".dot-mic");
        if (!els.video) { readyResolve(); return; }

        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: true, audio: true,
            });
        } catch (err) {
            console.warn("getUserMedia failed:", err.name, err.message);
            readyResolve();
            return;
        }

        els.video.srcObject = cameraStream;
        els.tile.classList.add("has-stream");
        enableControls();
        readyResolve();
    }

    function enableControls() {
        for (const btn of [els.micBtn, els.camBtn, els.shareBtn]) {
            if (!btn) continue;
            btn.removeAttribute("disabled");
            btn.removeAttribute("title");
        }
        els.micBtn?.addEventListener("click", toggleAudio);
        els.camBtn?.addEventListener("click", toggleVideo);
        els.shareBtn?.addEventListener("click", toggleShare);
    }

    function toggleAudio() {
        const track = cameraStream?.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setBtnState(els.micBtn, track.enabled ? "on" : "off");
        setBtnLabel(els.micBtn, track.enabled ? "Mute" : "Unmute");
        els.micDot?.classList.toggle("is-muted", !track.enabled);
        broadcastState();
    }

    function toggleVideo() {
        const track = cameraStream?.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        setBtnState(els.camBtn, track.enabled ? "on" : "off");
        setBtnLabel(els.camBtn, track.enabled ? "Camera" : "Camera off");
        if (!displayStream) {
            els.tile.classList.toggle("has-stream", track.enabled);
        }
        broadcastState();
    }

    function broadcastState() {
        // Tell the server (which broadcasts to peers) about the local mic/cam
        // state so remote tiles can show muted / camera-off indicators.
        // Screen share keeps the outbound video "on" semantically — others
        // are receiving frames, just from the display stream instead of the cam.
        const audio = cameraStream?.getAudioTracks()[0]?.enabled ?? false;
        const camOn = cameraStream?.getVideoTracks()[0]?.enabled ?? false;
        const video = displayStream ? true : camOn;
        signaling.send("peer-state", { audio, video });
    }

    async function toggleShare() {
        if (displayStream) { stopShare(); return; }
        try {
            displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        } catch (err) {
            console.warn("getDisplayMedia failed:", err.name, err.message);
            return;
        }
        const videoTrack = displayStream.getVideoTracks()[0];
        videoTrack.addEventListener("ended", stopShare);

        els.video.srcObject = displayStream;
        els.tile.classList.add("has-stream");
        mesh.replaceOutgoingVideo(videoTrack);     // swap on every peer connection

        setBtnState(els.shareBtn, "on");
        setBtnLabel(els.shareBtn, "Stop");
        broadcastState();
    }

    function stopShare() {
        if (!displayStream) return;
        for (const t of displayStream.getTracks()) t.stop();
        displayStream = null;

        if (cameraStream) {
            els.video.srcObject = cameraStream;
            const camTrack = cameraStream.getVideoTracks()[0];
            els.tile.classList.toggle("has-stream", camTrack?.enabled ?? true);
            mesh.replaceOutgoingVideo(camTrack);   // restore to camera on all peers
        }
        setBtnState(els.shareBtn, "off");
        setBtnLabel(els.shareBtn, "Share");
        broadcastState();
    }

    function stop() {
        for (const s of [cameraStream, displayStream]) {
            if (s) for (const t of s.getTracks()) t.stop();
        }
        cameraStream = displayStream = null;
        if (els.video) els.video.srcObject = null;
    }

    function setBtnState(btn, state) { btn?.setAttribute("data-state", state); }
    function setBtnLabel(btn, text) {
        const el = btn?.querySelector(".ctrl-label");
        if (el) el.textContent = text;
    }

    return {
        start, stop, ready,
        getCameraStream: () => cameraStream,
        getActiveStream: () => displayStream || cameraStream,
    };
})();

/* -------------------------------------------------------------------------- */
/* Signaling: WebSocket to /ws/room/<code>/                                   */
/* -------------------------------------------------------------------------- */

const signaling = (() => {
    let ws = null;
    let myPeerId = null;
    /** type → array of subscribers. Multiple modules can listen to the same
     *  event (e.g. both `people` and `mesh` care about `roster`). */
    const handlers = {};

    function open() {
        const code = document.querySelector(".room")?.dataset.roomCode;
        if (!code) return;
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${location.host}/ws/room/${code}/`;
        ws = new WebSocket(url);
        ws.addEventListener("open",    () => console.log("[ws] open", url));
        ws.addEventListener("close",   (e) => {
            console.log("[ws] close", e.code, e.reason);
            // Phase 13 close codes — friendly messages for the gated joiner.
            if (e.code === 4007) {
                showGateMessage(
                    "The host has left this meeting",
                    "Try again in a moment.",
                );
            } else if (e.code === 4008) {
                showGateMessage(
                    "Your request was declined",
                    "The host did not let you in.",
                );
            }
        });
        ws.addEventListener("error",   (e) => console.warn("[ws] error", e));
        ws.addEventListener("message", (e) => {
            let data; try { data = JSON.parse(e.data); } catch { return; }
            const t = data.type;
            if (t === "hello") myPeerId = data.peer_id;
            const subs = handlers[t];
            if (subs) for (const fn of subs) { try { fn(data); } catch (err) { console.warn(t, "handler failed", err); } }
        });
    }

    return {
        open,
        on:    (type, fn) => { (handlers[type] ||= []).push(fn); },
        send:  (type, payload) => {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type, ...payload }));
            }
        },
        close: () => ws?.close(),
        get peerId() { return myPeerId; },
    };
})();

/* -------------------------------------------------------------------------- */
/* People list: server-driven roster + live join/leave updates                */
/* -------------------------------------------------------------------------- */

const people = (() => {
    const list = document.getElementById("people-list");
    const count = document.getElementById("people-count");
    if (!list) return { init() {} };

    /** peer_id → <li> element. The local user is keyed under "local". */
    const items = new Map();
    const localLi = list.querySelector('[data-peer="local"]');
    if (localLi) items.set("local", localLi);

    function updateCount() {
        if (count) count.textContent = String(items.size);
    }
    updateCount();

    function add(peerId, name, state) {
        if (items.has(peerId)) return;
        const li = document.createElement("li");
        li.className = "people-item";
        li.dataset.peer = peerId;
        const initial = (name || "?").slice(0, 1).toUpperCase();
        // textContent on all user-provided fields — XSS-safe.
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = initial;
        const nameEl = document.createElement("span");
        nameEl.className = "people-name";
        nameEl.textContent = name || `peer ${peerId.slice(0, 6)}`;
        const muteIcon = document.createElement("span");
        muteIcon.className = "people-mute";
        muteIcon.title = "Muted";
        muteIcon.textContent = "🔇";
        li.appendChild(avatar);
        li.appendChild(nameEl);
        li.appendChild(muteIcon);
        list.appendChild(li);
        items.set(peerId, li);
        if (state) applyState(peerId, state);
        updateCount();
    }

    function applyState(peerId, { audio, video }) {
        const li = items.get(peerId);
        if (!li) return;
        if (audio !== undefined) li.classList.toggle("is-muted", audio === false);
        if (video !== undefined) li.classList.toggle("is-cam-off", video === false);
    }

    function remove(peerId) {
        const li = items.get(peerId);
        if (!li) return;
        li.remove();
        items.delete(peerId);
        updateCount();
    }

    function clearRemote() {
        for (const [pid, li] of items) {
            if (pid === "local") continue;
            li.remove();
            items.delete(pid);
        }
        updateCount();
    }

    function init() {
        signaling.on("roster",      ({ peers }) => peers.forEach((p) => add(p.peer_id, p.name, p)));
        signaling.on("peer-joined", ({ peer_id, name }) => add(peer_id, name));
        signaling.on("peer-left",   ({ peer_id }) => remove(peer_id));
        signaling.on("peer-state",  (evt) => applyState(evt.peer_id, evt));
    }

    return { init, clearRemote };
})();

/* -------------------------------------------------------------------------- */
/* Knock & admit (Phase 13)                                                   */
/*                                                                            */
/* Every non-host joiner enters the room in a pending state — the server      */
/* parks them and notifies the host. The browser-side view is:                */
/*   - non-host: render the waiting overlay until `admitted` arrives, then    */
/*     start localMedia (which prompts for camera/mic only after admission).  */
/*   - host: render a knock tray; each `knock` event adds a card with         */
/*     Admit / Deny buttons that wire to the matching server messages.        */
/* -------------------------------------------------------------------------- */

const knockGate = (() => {
    const root = document.querySelector(".room");
    const isHost = root?.dataset.isHost === "1";

    function init() {
        if (isHost) return;
        // Non-host: stay parked until the server explicitly admits us.
        // localMedia.start() is deferred so we don't prompt for camera/mic
        // before we even know if the host will let us in.
        signaling.on("admitted", () => {
            document.getElementById("waiting-overlay")?.remove();
            localMedia.start();
        });
    }

    return { init, get isHost() { return isHost; } };
})();

const knockTray = (() => {
    const tray = document.getElementById("knock-tray");
    /** peer_id → <div> card element */
    const cards = new Map();

    function init() {
        if (!tray) return;
        signaling.on("knock", ({ peer_id, name }) => addCard(peer_id, name));
        signaling.on("pending-knocks", ({ knocks }) => {
            knocks.forEach(({ peer_id, name }) => addCard(peer_id, name));
        });
        signaling.on("knock-cancelled", ({ peer_id }) => removeCard(peer_id));
    }

    function addCard(peerId, name) {
        if (cards.has(peerId)) return;
        const card = document.createElement("div");
        card.className = "knock-card";
        card.dataset.peer = peerId;

        const who = document.createElement("div");
        who.className = "knock-who";
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = (name || "?").slice(0, 1).toUpperCase();
        const nameEl = document.createElement("span");
        nameEl.className = "knock-name";
        nameEl.textContent = name || `peer ${peerId.slice(0, 6)}`;
        const sub = document.createElement("span");
        sub.className = "knock-sub";
        sub.textContent = "wants to join";
        who.appendChild(avatar);
        who.appendChild(nameEl);
        who.appendChild(sub);

        const actions = document.createElement("div");
        actions.className = "knock-actions";
        const admitBtn = document.createElement("button");
        admitBtn.type = "button";
        admitBtn.className = "knock-admit";
        admitBtn.textContent = "Admit";
        admitBtn.addEventListener("click", () => {
            signaling.send("admit", { peer_id: peerId });
            removeCard(peerId);
        });
        const denyBtn = document.createElement("button");
        denyBtn.type = "button";
        denyBtn.className = "knock-deny";
        denyBtn.textContent = "Deny";
        denyBtn.addEventListener("click", () => {
            signaling.send("deny", { peer_id: peerId });
            removeCard(peerId);
        });
        actions.appendChild(admitBtn);
        actions.appendChild(denyBtn);

        card.appendChild(who);
        card.appendChild(actions);
        tray.appendChild(card);
        cards.set(peerId, card);
    }

    function removeCard(peerId) {
        const card = cards.get(peerId);
        if (!card) return;
        card.remove();
        cards.delete(peerId);
    }

    return { init };
})();

/** Replace the waiting overlay with a terminal status message + a way out. */
function showGateMessage(title, body) {
    let overlay = document.getElementById("waiting-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "waiting-overlay";
        overlay.className = "waiting-overlay";
        document.body.appendChild(overlay);
    }
    overlay.classList.add("is-error");
    overlay.textContent = "";  // clear

    const card = document.createElement("div");
    card.className = "waiting-card";
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = body;
    const a = document.createElement("a");
    a.className = "btn-ghost";
    a.href = "/";
    a.textContent = "Back to dashboard";

    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(a);
    overlay.appendChild(card);
}

/* -------------------------------------------------------------------------- */
/* Mesh: RTCPeerConnection per peer + remote tile rendering                   */
/* -------------------------------------------------------------------------- */

const mesh = (() => {
    /** peer_id → { pc, name, tile, hasRemoteDesc, pendingIce } */
    const peers = new Map();

    function init() {
        signaling.on("peer-joined",   onPeerJoined);
        signaling.on("peer-left",     onPeerLeft);
        signaling.on("signal-offer",  onOffer);
        signaling.on("signal-answer", onAnswer);
        signaling.on("signal-ice",    onIce);
        signaling.on("room-closed",   onRoomClosed);
        signaling.on("peer-state",    onPeerState);
        signaling.on("roster",        ({ peers }) => peers.forEach(applyPeerState));
    }

    function applyPeerState({ peer_id, audio, video }) {
        const tile = document.querySelector(`.tile[data-peer="${cssEscape(peer_id)}"]`);
        if (!tile) return;
        const micDot = tile.querySelector(".dot-mic");
        if (micDot) micDot.classList.toggle("is-muted", audio === false);
        // When the remote camera is off, drop .has-stream so the placeholder
        // (avatar + name) shows in place of the black video. Restore it when
        // they turn the camera back on — the underlying stream is still wired
        // up via pc.ontrack, only `track.enabled` flipped.
        tile.classList.toggle("has-stream", video !== false);
    }

    function onPeerState(evt) { applyPeerState(evt); }

    // Host ended the meeting → tear down media + PCs and bounce to dashboard.
    // The server also closes the WS with code 4005 right after sending this.
    function onRoomClosed() {
        closeAll();
        localMedia.stop();
        signaling.close();
        window.location.replace("/?ended=1");
    }

    // Existing peers receive peer-joined for newcomers and initiate the offer.
    async function onPeerJoined({ peer_id, name }) {
        await localMedia.ready;
        if (peers.has(peer_id)) return;
        const entry = createEntry(peer_id, name);
        addLocalTracks(entry.pc);
        try {
            const offer = await entry.pc.createOffer();
            await entry.pc.setLocalDescription(offer);
            signaling.send("signal-offer", { to: peer_id, sdp: entry.pc.localDescription });
        } catch (err) {
            console.warn("offer failed for", peer_id, err);
        }
    }

    // Newcomer receives offers from existing peers, answers each.
    async function onOffer({ from, sdp }) {
        await localMedia.ready;
        let entry = peers.get(from);
        if (!entry) entry = createEntry(from, null);
        try {
            await entry.pc.setRemoteDescription(sdp);
            entry.hasRemoteDesc = true;
            await flushPendingIce(entry);
            addLocalTracks(entry.pc);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            signaling.send("signal-answer", { to: from, sdp: entry.pc.localDescription });
        } catch (err) {
            console.warn("answer failed for", from, err);
        }
    }

    async function onAnswer({ from, sdp }) {
        const entry = peers.get(from);
        if (!entry) return;
        try {
            await entry.pc.setRemoteDescription(sdp);
            entry.hasRemoteDesc = true;
            await flushPendingIce(entry);
        } catch (err) {
            console.warn("setRemoteDescription(answer) failed for", from, err);
        }
    }

    async function onIce({ from, candidate }) {
        const entry = peers.get(from);
        if (!entry) return;
        if (!candidate) return;
        if (entry.hasRemoteDesc) {
            try { await entry.pc.addIceCandidate(candidate); }
            catch (err) { console.warn("addIceCandidate failed", err); }
        } else {
            // Remote description not set yet — buffer the candidate.
            entry.pendingIce.push(candidate);
        }
    }

    async function flushPendingIce(entry) {
        for (const c of entry.pendingIce) {
            try { await entry.pc.addIceCandidate(c); }
            catch (err) { console.warn("flushed ICE failed", err); }
        }
        entry.pendingIce = [];
    }

    function onPeerLeft({ peer_id }) {
        const entry = peers.get(peer_id);
        if (!entry) return;
        try { entry.pc.close(); } catch {}
        entry.tile?.remove();
        peers.delete(peer_id);
        updateTileCount();
    }

    function createEntry(peerId, name) {
        const pc = new RTCPeerConnection(RTC_CONFIG);

        pc.addEventListener("icecandidate", (e) => {
            if (e.candidate) {
                signaling.send("signal-ice", { to: peerId, candidate: e.candidate });
            }
        });

        pc.addEventListener("track", (e) => {
            const stream = e.streams[0] || new MediaStream([e.track]);
            const tile = ensureTile(peerId);
            const video = tile.querySelector(".tile-video");
            if (video.srcObject !== stream) video.srcObject = stream;
            tile.classList.add("has-stream");
        });

        const entry = {
            pc,
            name: name || "peer",
            tile: ensureTile(peerId, name),  // placeholder visible immediately
            hasRemoteDesc: false,
            pendingIce: [],
        };
        peers.set(peerId, entry);
        return entry;
    }

    function addLocalTracks(pc) {
        const stream = localMedia.getActiveStream();
        if (!stream) return;
        const senders = pc.getSenders();
        for (const track of stream.getTracks()) {
            if (!senders.some((s) => s.track === track)) {
                pc.addTrack(track, stream);
            }
        }
    }

    /** Replace the outgoing video track on every peer connection.
     *  Used by screen-share start/stop. No SDP renegotiation needed. */
    function replaceOutgoingVideo(newTrack) {
        for (const { pc } of peers.values()) {
            for (const sender of pc.getSenders()) {
                if (sender.track?.kind === "video") {
                    sender.replaceTrack(newTrack).catch((err) =>
                        console.warn("replaceTrack failed", err));
                }
            }
        }
    }

    function ensureTile(peerId, name) {
        const existing = document.querySelector(`.tile[data-peer="${cssEscape(peerId)}"]`);
        if (existing) return existing;
        const grid = document.getElementById("tile-grid");
        const tile = createTile(peerId, name);
        grid.appendChild(tile);
        updateTileCount();
        return tile;
    }

    function createTile(peerId, name) {
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.dataset.peer = peerId;
        const initial = (name || "?").slice(0, 1).toUpperCase();
        const label = name || `peer ${peerId.slice(0, 6)}`;
        tile.innerHTML = `
            <video class="tile-video" autoplay playsinline></video>
            <div class="tile-placeholder">
                <span class="avatar">${escapeHtml(initial)}</span>
                <span class="tile-label">${escapeHtml(label)}</span>
            </div>
            <div class="tile-badge"><span class="dot dot-mic"></span> ${escapeHtml(label)}</div>
        `;
        return tile;
    }

    function updateTileCount() {
        const grid = document.getElementById("tile-grid");
        if (!grid) return;
        const count = grid.querySelectorAll(".tile").length;
        grid.setAttribute("data-tile-count", String(Math.min(count, 6)));
    }

    function closeAll() {
        for (const { pc, tile } of peers.values()) {
            try { pc.close(); } catch {}
            tile?.remove();
        }
        peers.clear();
        updateTileCount();
    }

    return { init, replaceOutgoingVideo, closeAll };
})();

/* small helpers */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}
function cssEscape(s) {
    return (window.CSS?.escape ?? ((x) => String(x).replace(/[^\w-]/g, "\\$&")))(s);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
    // Subscribe handlers first so nothing is missed once the WS opens.
    people.init();      // roster / peer-joined / peer-left / peer-state
    mesh.init();        // signaling events for WebRTC mesh
    knockTray.init();   // host-only — populates the knock tray
    knockGate.init();   // non-host only — defers localMedia until admitted
    signaling.open();

    // Hosts start media immediately; non-hosts wait for `admitted`
    // (see knockGate). This avoids prompting for camera/mic to people who
    // might never be let in.
    if (knockGate.isHost) {
        localMedia.start();
    }
});

window.addEventListener("pagehide", () => {
    mesh.closeAll();
    localMedia.stop();
    signaling.close();
});

document.querySelector(".ctrl-leave")?.addEventListener("click", () => {
    mesh.closeAll();
    localMedia.stop();
    signaling.close();
});
