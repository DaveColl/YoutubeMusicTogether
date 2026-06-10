// Runs inside the Chrome offscreen document — has full DOM/WebRTC APIs.
// Handles all PeerJS logic for Chrome. Communicates with background.js via messages.

let peer = null;
let connections = new Set(); // host: open DataConnections to clients
let hostConn = null;         // client: DataConnection to host
let isHost = false;
let roomCode = null;

function toBackground(msg) {
  chrome.runtime.sendMessage({ ...msg, from: 'offscreen' });
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function peerId(code) {
  return `ytmt-${code}`;
}

function setupClientConn(conn) {
  conn.on('open', () => {
    isHost = false;
    toBackground({ type: 'PEER_ROOM_JOINED', roomCode: conn.peer.replace('ytmt-', '') });
  });
  conn.on('data', (state) => {
    toBackground({ type: 'PEER_STATE_RECEIVED', state });
  });
  conn.on('close', () => {
    toBackground({ type: 'PEER_HOST_DISCONNECTED' });
    if (roomCode && peer && !peer.destroyed) {
      setTimeout(() => {
        hostConn = peer.connect(peerId(roomCode), { reliable: true });
        setupClientConn(hostConn);
      }, 3000);
    }
  });
  conn.on('error', (err) => {
    toBackground({ type: 'PEER_ERROR', message: err.message });
  });
}

function createRoom(code) {
  const id = code ?? generateCode();

  if (peer && roomCode === id) {
    toBackground({ type: 'PEER_ROOM_CREATED', roomCode: id });
    return;
  }

  roomCode = id;

  peer = new Peer(peerId(id));

  peer.on('open', () => {
    isHost = true;
    toBackground({ type: 'PEER_ROOM_CREATED', roomCode: id });
  });

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      connections.add(conn);
      toBackground({ type: 'PEER_CLIENT_COUNT', count: connections.size });
      // Send current cached state to new joiner immediately
      toBackground({ type: 'PEER_REQUEST_STATE' });
    });
    conn.on('close', () => {
      connections.delete(conn);
      toBackground({ type: 'PEER_CLIENT_COUNT', count: connections.size });
    });
    conn.on('error', () => {
      connections.delete(conn);
      toBackground({ type: 'PEER_CLIENT_COUNT', count: connections.size });
    });
  });

  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      peer = null;
      createRoom(); // retry with new code
    } else {
      toBackground({ type: 'PEER_ERROR', message: err.message });
    }
  });
}

function joinRoom(code) {
  if (peer && roomCode === code) {
    toBackground({ type: 'PEER_ROOM_JOINED', roomCode: code });
    return;
  }

  roomCode = code;
  peer = new Peer();

  peer.on('open', () => {
    hostConn = peer.connect(peerId(code), { reliable: true });
    setupClientConn(hostConn);
  });

  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });

  peer.on('error', (err) => {
    toBackground({ type: 'PEER_ERROR', message: err.message });
  });
}

function broadcastToClients(state) {
  for (const conn of connections) {
    if (conn.open) conn.send(state);
  }
}

function leaveRoom() {
  connections.forEach((c) => c.close());
  connections.clear();
  if (hostConn) { hostConn.close(); hostConn = null; }
  if (peer) { peer.destroy(); peer = null; }
  isHost = false;
  roomCode = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'CREATE_ROOM': createRoom(msg.roomCode); break;
    case 'JOIN_ROOM': joinRoom(msg.roomCode); break;
    case 'LEAVE_ROOM': leaveRoom(); break;
    case 'BROADCAST_STATE': broadcastToClients(msg.state); break;
    case 'SEND_STATE_TO_NEW_CLIENT':
      // Background sends us the current host state so we can forward it to the latest joiner
      for (const conn of connections) {
        if (conn.open && !conn.__welcomed) {
          conn.send(msg.state);
          conn.__welcomed = true;
        }
      }
      break;
    default: break;
  }
});
