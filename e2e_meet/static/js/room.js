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
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
    ],
};

/* -------------------------------------------------------------------------- */
/* Chat panel toggle                                                          */
/* -------------------------------------------------------------------------- */

(function initChatToggle() {
    const panel = document.getElementById("chat-panel");
    const openBtn = document.getElementById("toggle-chat");
    const closeBtn = document.getElementById("chat-close");
    if (!panel || !openBtn) return;

    function setOpen(open) {
        panel.classList.toggle("is-open", open);
        panel.setAttribute("aria-hidden", open ? "false" : "true");
        openBtn.setAttribute("data-state", open ? "on" : "off");
    }
    openBtn.addEventListener("click", () => setOpen(!panel.classList.contains("is-open")));
    if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));
})();

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
    const handlers = {};

    function open() {
        const code = document.querySelector(".room")?.dataset.roomCode;
        if (!code) return;
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${location.host}/ws/room/${code}/`;
        ws = new WebSocket(url);
        ws.addEventListener("open",    () => console.log("[ws] open", url));
        ws.addEventListener("close",   (e) => console.log("[ws] close", e.code, e.reason));
        ws.addEventListener("error",   (e) => console.warn("[ws] error", e));
        ws.addEventListener("message", (e) => {
            let data; try { data = JSON.parse(e.data); } catch { return; }
            const t = data.type;
            if (t === "hello") myPeerId = data.peer_id;
            handlers[t]?.(data);
        });
    }

    return {
        open,
        on:    (type, fn) => { handlers[type] = fn; },
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
    localMedia.start();
    mesh.init();        // subscribe to signaling events before opening the WS
    signaling.open();
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
