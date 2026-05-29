/*
 * chat.js — Phase 8 (real-time chat).
 *
 * Depends on `signaling` (defined in room.js). Must load *after* room.js.
 *
 * Server contract:
 *   send:     {type: "chat-message", body: "..."}
 *   receive:  {type: "chat-broadcast", author, body, ts}   (ts is ISO 8601)
 *
 * History is rendered server-side in the template; this module appends new
 * messages to the same #chat-messages list and removes the empty-state li
 * once at least one message exists.
 *
 * XSS safety: everything from the network goes through textContent, never
 * innerHTML.
 */

(function initChat() {
    const form  = document.getElementById("chat-form");
    const input = document.getElementById("chat-input");
    const list  = document.getElementById("chat-messages");
    const sendBtn = form?.querySelector("button[type='submit']");
    const chatPanel = document.getElementById("chat-panel");
    const badge = document.getElementById("chat-count");
    const myName = document.querySelector(".room")?.dataset.displayName || "";
    if (!form || !input || !list) return;

    // Unread badge on the Chat control button. Bumps on incoming messages
    // when the panel is closed; resets when the panel opens.
    let unread = 0;
    function paintBadge() {
        if (!badge) return;
        if (unread > 0) {
            badge.textContent = unread > 99 ? "99+" : String(unread);
            badge.hidden = false;
        } else {
            badge.hidden = true;
        }
    }
    if (chatPanel) {
        // Reset on every open. MutationObserver runs regardless of which code
        // path opened the panel (toggle button, close button, future shortcuts).
        new MutationObserver(() => {
            if (chatPanel.classList.contains("is-open")) {
                unread = 0;
                paintBadge();
            }
        }).observe(chatPanel, { attributes: true, attributeFilter: ["class"] });
    }

    // Enable input + button once the WS opens (chat works even if camera was denied).
    function setEnabled(enabled) {
        input.disabled = !enabled;
        if (sendBtn) sendBtn.disabled = !enabled;
        if (enabled) input.placeholder = "Type a message…";
        else         input.placeholder = "Connecting…";
    }
    setEnabled(false);

    // Enable on the `roster` event — sent only after admission (Phase 13).
    // Pending knockers see `hello` early but no roster, so chat stays disabled
    // for them until the host admits.
    signaling.on("roster", () => setEnabled(true));

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        signaling.send("chat-message", { body });
        input.value = "";
        input.focus();
    });

    signaling.on("chat-broadcast", ({ author, body, ts }) => {
        // Drop the "No messages yet." placeholder once the first real message arrives.
        list.querySelector(".chat-empty")?.remove();
        list.appendChild(buildMessageItem(author, body, ts));
        list.scrollTop = list.scrollHeight;

        // Bump the unread badge only when the panel is closed and the message
        // isn't from this user. (Two participants with the same display name
        // would shadow each other here — acceptable v1 edge case.)
        const panelOpen = chatPanel?.classList.contains("is-open");
        if (!panelOpen && author !== myName) {
            unread++;
            paintBadge();
        }
    });

    function buildMessageItem(author, body, isoTs) {
        const li = document.createElement("li");
        li.className = "chat-msg";

        const meta = document.createElement("div");
        meta.className = "chat-msg-meta";
        const authorEl = document.createElement("strong");
        authorEl.textContent = author;
        const tsEl = document.createElement("span");
        tsEl.textContent = formatTime(isoTs);
        meta.appendChild(authorEl);
        meta.appendChild(tsEl);

        const bodyEl = document.createElement("div");
        bodyEl.className = "chat-msg-body";
        bodyEl.textContent = body;  // textContent, never innerHTML

        li.appendChild(meta);
        li.appendChild(bodyEl);
        return li;
    }

    function formatTime(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        } catch {
            return "";
        }
    }
})();
