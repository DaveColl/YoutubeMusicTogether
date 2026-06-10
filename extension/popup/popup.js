let bgPort = null;

function connectPort() {
  bgPort = chrome.runtime.connect({ name: "popup" });
  bgPort.onMessage.addListener(handleBgMessage);
  bgPort.onDisconnect.addListener(() => {
    bgPort = null;
  });
}

function sendToBackground(msg) {
  // One-way fire — no response expected
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function handleBgMessage(msg) {
  switch (msg.type) {
    case "ROOM_CREATED":
      showView("host");
      setEl("host-room-code", msg.roomCode);
      break;

    case "ROOM_JOINED":
      showView("client");
      setEl("client-room-code", msg.roomCode);
      setEl("sync-status", "Connected — syncing...");
      break;

    case "STATE_UPDATE":
      setEl("client-title", msg.title || "—");
      setEl("client-artist", msg.artist || "");
      setEl("host-title", msg.title || "—");
      setEl("host-artist", msg.artist || "");
      setEl("sync-status", "Synced");
      show("reconnect-notice", false);
      break;

    case "CLIENT_COUNT":
      setEl(
        "client-count",
        `${msg.count} listener${msg.count !== 1 ? "s" : ""} connected`,
      );
      break;

    case "HOST_DISCONNECTED":
      show("reconnect-notice", true);
      setEl("sync-status", "Host disconnected — reconnecting…");
      break;

    case "HOST_LEFT":
      showView("no-room");
      showError("Host left the room.");
      break;

    case "ERROR":
    case "PEER_ERROR":
      showError(msg.message || "Connection error.");
      break;

    default:
      break;
  }
}

// ── View management ───────────────────────────────────────────────────────────

function showView(name) {
  document
    .getElementById("view-no-room")
    .classList.toggle("hidden", name !== "no-room");
  document
    .getElementById("view-host")
    .classList.toggle("hidden", name !== "host");
  document
    .getElementById("view-client")
    .classList.toggle("hidden", name !== "client");
  hideError();
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function show(id, visible) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("hidden", !visible);
}

function showError(msg) {
  const el = document.getElementById("error-msg");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideError() {
  document.getElementById("error-msg")?.classList.add("hidden");
}

// ── Init: restore state from content script on popup open ────────────────────

chrome.runtime.sendMessage({ type: "GET_STATUS" }, (status) => {
  if (chrome.runtime.lastError || !status?.isInRoom) {
    showView("no-room");
    return;
  }
  if (status.isHost) {
    showView("host");
    setEl("host-room-code", status.roomCode ?? "");
    setEl(
      "client-count",
      `${status.clientCount || 0} listener${status.clientCount !== 1 ? "s" : ""} connected`,
    );
  } else {
    showView("client");
    setEl("client-room-code", status.roomCode ?? "");
  }
});

// ── Buttons ───────────────────────────────────────────────────────────────────

document.getElementById("btn-create").addEventListener("click", () => {
  hideError();
  sendToBackground({ type: "CREATE_ROOM" });
});

document.getElementById("btn-join").addEventListener("click", () => {
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!code || code.length !== 6) {
    showError("Enter the 6-character room code.");
    return;
  }
  hideError();
  sendToBackground({ type: "JOIN_ROOM", roomCode: code });
});

document.getElementById("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join").click();
});

document.getElementById("join-code").addEventListener("input", (e) => {
  const s = e.target.selectionStart,
    end = e.target.selectionEnd;
  e.target.value = e.target.value.toUpperCase();
  e.target.setSelectionRange(s, end);
});

document.getElementById("btn-copy").addEventListener("click", () => {
  const code = document.getElementById("host-room-code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById("btn-copy");
    btn.textContent = "✓";
    setTimeout(() => {
      btn.textContent = "📋";
    }, 1500);
  });
});

document.getElementById("btn-leave-host").addEventListener("click", () => {
  sendToBackground({ type: "LEAVE_ROOM" });
  showView("no-room");
});

document.getElementById("btn-leave-client").addEventListener("click", () => {
  sendToBackground({ type: "LEAVE_ROOM" });
  showView("no-room");
});

connectPort();
