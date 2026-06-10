// In Firefox MV3, background.scripts creates a real background PAGE (has window, RTCPeerConnection).
// In Chrome MV3, background.service_worker is a service worker (no RTCPeerConnection).
// We detect which context we're in and use the right P2P path.
const IS_FIREFOX = typeof window !== "undefined";

// ICE config passed to every Peer (Firefox path). STUN handles non-symmetric NATs with
// zero setup; the TURN relay is required for symmetric-NAT / strict-firewall peers (most
// cross-network pairs). Fill in real TURN creds (e.g. Metered free tier —
// https://dashboard.metered.ca) where marked. Keep this in sync with the copy in offscreen.js.
// Multiple STUN servers give the browser the best chance of discovering its public
// IP/port behind NAT. STUN only ever sees your IP address — no music data passes
// through it. Works for ~85% of cross-network pairs with zero signup/credentials.
// The remaining ~15% (symmetric NAT) would need a TURN relay; left out intentionally.
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
    ],
  },
};

// ── Shared state ──────────────────────────────────────────────────────────────

let roomCode = null;
let isHost = false;
let ytMusicTabId = null;
let lastKnownState = null; // most recent HOST_STATE — used to catch up late joiners
let clientCount = 0;

const popupPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  }
});

function sendToPopup(msg) {
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {}
  }
}

async function findYTMTab() {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  return tabs[0] ?? null;
}

async function sendToContent(msg) {
  const id = ytMusicTabId ?? (await findYTMTab())?.id;
  if (!id) {
    sendToPopup({
      type: "ERROR",
      message: "Open YouTube Music (music.youtube.com) first.",
    });
    return null;
  }
  return chrome.tabs.sendMessage(id, msg).catch(() => {
    sendToPopup({
      type: "ERROR",
      message: "Could not reach YouTube Music tab — try refreshing it.",
    });
    return null;
  });
}

// Called when we confirm a room was created/joined
function onRoomCreated(code) {
  roomCode = code;
  isHost = true;
  chrome.storage.local.set({ roomCode: code, isHost: true });
  sendToContent({ type: "ROOM_CREATED", roomCode: code });
  sendToPopup({ type: "ROOM_CREATED", roomCode: code });
}

function onRoomJoined(code) {
  roomCode = code;
  isHost = false;
  chrome.storage.local.set({ roomCode: code, isHost: false });
  sendToContent({ type: "ROOM_JOINED", roomCode: code });
  sendToPopup({ type: "ROOM_JOINED", roomCode: code });
}

function onStateReceived(state) {
  sendToContent({ ...state, type: "APPLY_STATE" });
  sendToPopup({ ...state, type: "STATE_UPDATE" });
}

function onHostDisconnected() {
  sendToPopup({ type: "HOST_DISCONNECTED" });
}

function onHostLeft() {
  roomCode = null;
  isHost = false;
  chrome.storage.local.remove(["roomCode", "isHost"]);
  sendToContent({ type: "HOST_LEFT" });
  sendToPopup({ type: "HOST_LEFT" });
}

function onPeerError(message) {
  sendToPopup({ type: "PEER_ERROR", message });
}

function onClientCount(count) {
  clientCount = count;
  sendToPopup({ type: "CLIENT_COUNT", count });
}

// ── Chrome path — offscreen document ─────────────────────────────────────────

let offscreenCreated = false;

async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["WEB_RTC"],
        justification: "WebRTC P2P peer connection",
      });
    }
    offscreenCreated = true;
  } catch (e) {
    console.error("[YMT] Failed to create offscreen document:", e);
  }
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ ...msg, target: "offscreen" }).catch(() => {});
}

// ── Firefox path — Peer runs directly here (background page has RTCPeerConnection) ──

let ffPeer = null;
let ffConnections = new Set();
let ffHostConn = null;

function ffGenerateCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(
    { length: 6 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

function ffPeerId(code) {
  return `ytmt-${code}`;
}

function ffBroadcast(state) {
  for (const conn of ffConnections) {
    if (conn.open) conn.send(state);
  }
}

function ffSetupClientConn(conn) {
  conn.on("open", () => {
    onRoomJoined(conn.peer.replace("ytmt-", ""));
  });
  conn.on("data", (state) => {
    onStateReceived(state);
  });
  conn.on("close", () => {
    onHostDisconnected();
    if (roomCode && ffPeer && !ffPeer.destroyed) {
      setTimeout(() => {
        ffHostConn = ffPeer.connect(ffPeerId(roomCode), { reliable: true });
        ffSetupClientConn(ffHostConn);
      }, 3000);
    }
  });
  conn.on("error", (err) => onPeerError(err.message));
}

function ffCreateRoom(code) {
  const id = code ?? ffGenerateCode();

  ffPeer = new Peer(ffPeerId(id), PEER_CONFIG); // Peer is available via background.scripts: ["peerjs.min.js", ...]

  ffPeer.on("open", () => {
    onRoomCreated(id);
  });

  ffPeer.on("connection", (conn) => {
    conn.on("open", () => {
      ffConnections.add(conn);
      onClientCount(ffConnections.size);
      // Send current state to late joiner
      if (lastKnownState && conn.open) conn.send(lastKnownState);
    });
    conn.on("close", () => {
      ffConnections.delete(conn);
      onClientCount(ffConnections.size);
    });
    conn.on("error", () => {
      ffConnections.delete(conn);
      onClientCount(ffConnections.size);
    });
  });

  ffPeer.on("disconnected", () => {
    if (!ffPeer.destroyed) ffPeer.reconnect();
  });

  ffPeer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      ffPeer.destroy();
      ffPeer = null;
      ffCreateRoom(); // retry with new code
    } else {
      onPeerError(err.message);
    }
  });
}

function ffJoinRoom(code) {
  ffPeer = new Peer(undefined, PEER_CONFIG);

  ffPeer.on("open", () => {
    ffHostConn = ffPeer.connect(ffPeerId(code), { reliable: true });
    ffSetupClientConn(ffHostConn);
  });

  ffPeer.on("disconnected", () => {
    if (!ffPeer.destroyed) ffPeer.reconnect();
  });
  ffPeer.on("error", (err) => onPeerError(err.message));
}

function ffLeaveRoom() {
  ffConnections.forEach((c) => c.close());
  ffConnections.clear();
  if (ffHostConn) {
    ffHostConn.close();
    ffHostConn = null;
  }
  if (ffPeer) {
    ffPeer.destroy();
    ffPeer = null;
  }
}

// ── Unified API ───────────────────────────────────────────────────────────────

function createRoom(code) {
  if (IS_FIREFOX) ffCreateRoom(code);
  else toOffscreen({ type: "CREATE_ROOM", roomCode: code });
}

function joinRoom(code) {
  if (IS_FIREFOX) ffJoinRoom(code);
  else toOffscreen({ type: "JOIN_ROOM", roomCode: code });
}

function leaveRoom() {
  if (IS_FIREFOX) ffLeaveRoom();
  else toOffscreen({ type: "LEAVE_ROOM" });
  onHostLeft();
}

function broadcastState(state) {
  lastKnownState = state;
  if (IS_FIREFOX) ffBroadcast(state);
  else toOffscreen({ type: "BROADCAST_STATE", state });
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from offscreen document (Chrome only)
  if (msg.from === "offscreen") {
    switch (msg.type) {
      case "PEER_ROOM_CREATED":
        onRoomCreated(msg.roomCode);
        break;
      case "PEER_ROOM_JOINED":
        onRoomJoined(msg.roomCode);
        break;
      case "PEER_STATE_RECEIVED":
        onStateReceived(msg.state);
        break;
      case "PEER_HOST_DISCONNECTED":
        onHostDisconnected();
        break;
      case "PEER_CLIENT_COUNT":
        onClientCount(msg.count);
        break;
      case "PEER_ERROR":
        onPeerError(msg.message);
        break;
      case "PEER_REQUEST_STATE":
        // A new client just connected — send them the current host state
        if (lastKnownState) {
          toOffscreen({
            type: "SEND_STATE_TO_NEW_CLIENT",
            state: lastKnownState,
          });
        }
        break;
      default:
        break;
    }
    return;
  }

  // Messages from content script (has sender.tab)
  if (sender.tab) {
    ytMusicTabId = sender.tab.id;
    if (msg.type === "HOST_STATE" && isHost) {
      broadcastState(msg);
    } else if (msg.type === "GET_STATUS") {
      // Content script re-attaching after a page refresh needs the room state.
      sendResponse({ roomCode, isHost, isInRoom: !!roomCode, clientCount });
      return true;
    }
    return;
  }

  // Messages from popup (no sender.tab, not offscreen)
  switch (msg.type) {
    case "GET_STATUS":
      sendResponse({ roomCode, isHost, isInRoom: !!roomCode, clientCount });
      return true;

    case "CREATE_ROOM":
      createRoom();
      break;

    case "JOIN_ROOM":
      joinRoom(msg.roomCode);
      break;

    case "LEAVE_ROOM":
      leaveRoom();
      break;

    default:
      break;
  }
});

// ── Keepalive (Chrome MV3 service worker suspension guard) ────────────────────

if (!IS_FIREFOX) {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive" && roomCode) {
      // Offscreen documents persist independent of the service worker,
      // so just ensure ours is still alive
      ensureOffscreen();
    }
  });
}

// ── Restore after service worker restart ──────────────────────────────────────

chrome.storage.local.get(["roomCode", "isHost"], (data) => {
  if (!data.roomCode) return;
  // Rejoin the room we were in before the service worker was suspended
  roomCode = data.roomCode;
  isHost = data.isHost ?? false;
  if (isHost)
    createRoom(data.roomCode); // Note: may get a different code if peerjs ID was taken
  else joinRoom(data.roomCode);
});
