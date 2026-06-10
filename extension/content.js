// Content script for music.youtube.com — handles ONLY YouTube Music DOM interaction.
// All PeerJS / WebRTC logic lives in background.js (Firefox) or offscreen.js (Chrome).

// Register the message listener first — before anything that could throw.
chrome.runtime.onMessage.addListener(handleMessage);

// Guard: only run init once per page lifetime, even if injected multiple times.
if (!window.__ytmtInitialized) {
  window.__ytmtInitialized = true;
  init();
}

// ── State ─────────────────────────────────────────────────────────────────────

let isHost = false;
let isInRoom = false;
let pollInterval = null;
let navDebounceTimer = null;

// Host: the <video> we've attached event listeners to (YT Music swaps it on nav).
let hostVideoEl = null;

// Client: autoplay gating + time extrapolation state.
let audioUnlocked = false; // becomes true once the user clicks the unlock overlay
let overlayEl = null;
let pendingState = null; // last state received while still locked
let pendingNavId = null; // videoId we're currently navigating toward (loop guard)
let refHostTime = 0; // host currentTime from the most recent state
let refLocalClock = 0; // performance.now() when that state arrived
let hostIsPlaying = false; // whether the host was playing at the last update
let clientSyncInterval = null; // periodic drift corrector (client only)

const SEEK_THRESHOLD = 1; // seconds — only re-seek when drift exceeds this
const POLL_INTERVAL = 1000; // heartbeat; real-time changes are event-driven

// ── YouTube Music DOM helpers ─────────────────────────────────────────────────

function getVideo() {
  return document.querySelector("video");
}

function getVideoId() {
  try {
    const urlId = new URL(window.location.href).searchParams.get("v");
    if (urlId) return urlId;

    const playerBar = document.querySelector("ytmusic-player-bar");
    if (playerBar) {
      const link = playerBar.querySelector(
        'a.yt-simple-endpoint[href*="watch?v="]',
      );
      if (link) {
        return (
          new URL(link.href, window.location.origin).searchParams.get("v") ??
          null
        );
      }
    }
  } catch {}
  return null;
}

function getSongMeta() {
  const titleEl =
    document.querySelector("ytmusic-player-bar .title.ytmusic-player-bar") ||
    document.querySelector("ytmusic-player-bar #song-name") ||
    document.querySelector(".ytmusic-player-bar .title");
  const artistEl =
    document.querySelector("ytmusic-player-bar .byline a") ||
    document.querySelector("ytmusic-player-bar .subtitle a");
  return {
    title: titleEl?.textContent?.trim() ?? "",
    artist: artistEl?.textContent?.trim() ?? "",
  };
}

function getNextVideoId() {
  // Read the upcoming song from the queue so clients can anticipate autoplay.
  const items = document.querySelectorAll("ytmusic-player-queue-item");
  let foundCurrent = false;
  for (const item of items) {
    const isActive =
      item.hasAttribute("selected") ||
      item.classList.contains("iron-selected") ||
      item.hasAttribute("play-button-state") ||
      item.querySelector("[play-button-state]") != null;
    if (isActive) {
      foundCurrent = true;
      continue;
    }
    if (foundCurrent) {
      const link = item.querySelector('a[href*="watch?v="]');
      if (link) {
        try {
          return new URL(link.href).searchParams.get("v") ?? null;
        } catch {}
      }
      return (
        item.getAttribute("data-video-id") ||
        item.getAttribute("video-id") ||
        null
      );
    }
  }
  return null;
}

// ── Host: broadcast state to background ──────────────────────────────────────

function broadcastHostState() {
  if (!isHost || !isInRoom) return;
  const video = getVideo();
  const videoId = getVideoId();
  if (!video || !videoId) return;
  const { title, artist } = getSongMeta();
  chrome.runtime.sendMessage({
    type: "HOST_STATE",
    videoId,
    timestamp: video.currentTime,
    isPlaying: !video.paused,
    title,
    artist,
    nextVideoId: getNextVideoId(),
  });
}

// Push immediately whenever the host plays/pauses/seeks/skips — don't wait for the
// next poll tick. This is what makes start/stop/skip feel instant for clients.
const HOST_VIDEO_EVENTS = ["play", "pause", "seeked", "ratechange", "ended"];

function onHostVideoEvent() {
  broadcastHostState();
}

function attachHostVideoListeners() {
  if (!isHost || !isInRoom) return;
  const video = getVideo();
  if (!video || video === hostVideoEl) return;
  detachHostVideoListeners();
  hostVideoEl = video;
  for (const ev of HOST_VIDEO_EVENTS) {
    hostVideoEl.addEventListener(ev, onHostVideoEvent);
  }
}

function detachHostVideoListeners() {
  if (!hostVideoEl) return;
  for (const ev of HOST_VIDEO_EVENTS) {
    hostVideoEl.removeEventListener(ev, onHostVideoEvent);
  }
  hostVideoEl = null;
}

function startPolling() {
  attachHostVideoListeners();
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    // Re-attach in case YT Music replaced the <video> element on navigation.
    attachHostVideoListeners();
    broadcastHostState();
  }, POLL_INTERVAL);
}

function stopPolling() {
  clearInterval(pollInterval);
  pollInterval = null;
  detachHostVideoListeners();
}

// ── Client: apply state from background ──────────────────────────────────────

function navigateToVideo(videoId) {
  // Prefer SPA navigation so this content script stays alive. Fall back to a full
  // load — safe because the content script re-attaches to the room on init.
  const ytApp = document.querySelector("ytmusic-app");
  if (ytApp && typeof ytApp.navigate === "function") {
    ytApp.navigate(`/watch?v=${videoId}`);
  } else if (ytApp && typeof ytApp.navigate_ === "function") {
    ytApp.navigate_(`/watch?v=${videoId}`);
  } else {
    window.location.assign(`https://music.youtube.com/watch?v=${videoId}`);
  }
}

// Client autoplay is blocked until the user interacts with the page. Show a one-time
// overlay; the click is a user gesture that unlocks playback for the rest of the session.
function showUnlockOverlay() {
  if (overlayEl || audioUnlocked) return;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
    "justify-content:center;background:rgba(0,0,0,0.85);color:#fff;" +
    "font:600 18px/1.4 Roboto,Arial,sans-serif;cursor:pointer;text-align:center;padding:24px;";
  el.innerHTML =
    "<div>🎧 Click anywhere to start listening together<br>" +
    "<span style='font-weight:400;font-size:14px;opacity:0.8'>" +
    "(your browser blocks audio until you interact)</span></div>";
  el.addEventListener("click", () => {
    audioUnlocked = true;
    removeUnlockOverlay();
    const video = getVideo();
    // Kick playback within the gesture so the browser grants permission.
    if (video) video.play().catch(() => {});
    if (pendingState) {
      const s = pendingState;
      pendingState = null;
      applyState(s);
    }
  });
  overlayEl = el;
  document.body.appendChild(el);
}

function removeUnlockOverlay() {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

function applyState(state) {
  if (isHost || !isInRoom) return;
  const { videoId, timestamp, isPlaying } = state;

  // Switch songs when the host moves to a different track.
  if (videoId && videoId !== getVideoId()) {
    if (pendingNavId === videoId) return; // already navigating there
    pendingNavId = videoId;
    navigateToVideo(videoId);
    return;
  }
  pendingNavId = null;

  const video = getVideo();
  if (!video) return;

  // Anchor the host's position to our local clock so we can extrapolate forward
  // between updates instead of repeatedly snapping to an already-stale timestamp.
  refHostTime = timestamp ?? 0;
  refLocalClock = performance.now();
  hostIsPlaying = isPlaying;

  correctDrift(video);

  if (isPlaying) {
    if (video.paused) {
      video.play().catch(() => {
        // Autoplay blocked — stash state and prompt the user to unlock once.
        if (!audioUnlocked) {
          pendingState = state;
          showUnlockOverlay();
        }
      });
    }
    startClientSync();
  } else {
    stopClientSync();
    if (!video.paused) video.pause();
  }
}

// Seek only when the local position has drifted past the threshold from the host's
// extrapolated position — avoids constant micro-seeks that would stutter playback.
function correctDrift(video) {
  if (!video) return;
  const target = hostIsPlaying
    ? refHostTime + (performance.now() - refLocalClock) / 1000
    : refHostTime;
  if (Math.abs(video.currentTime - target) > SEEK_THRESHOLD) {
    video.currentTime = target;
  }
}

function startClientSync() {
  if (clientSyncInterval) return;
  clientSyncInterval = setInterval(() => {
    if (!isInRoom || isHost) return stopClientSync();
    const video = getVideo();
    if (video && !video.paused) correctDrift(video);
  }, 1000);
}

function stopClientSync() {
  clearInterval(clientSyncInterval);
  clientSyncInterval = null;
}

// ── SPA navigation detection (three layers) ──────────────────────────────────

function onNavigate() {
  clearTimeout(navDebounceTimer);
  navDebounceTimer = setTimeout(broadcastHostState, 300);
}

function setupSPANavigation() {
  // Layer 1: Patch history — wrapped in try/catch because Firefox content
  // scripts use XPCNativeWrapper which may reject assignment to history methods.
  try {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (...a) => {
      origPush(...a);
      window.dispatchEvent(new Event("ytmt-nav"));
    };
    history.replaceState = (...a) => {
      origReplace(...a);
      window.dispatchEvent(new Event("ytmt-nav"));
    };
    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("ytmt-nav")),
    );
    window.addEventListener("ytmt-nav", onNavigate);
  } catch (_) {
    // Firefox may block history patching — the other two layers cover this case.
  }

  // Layer 2: YouTube Music fires this after its own router completes
  window.addEventListener("yt-navigate-finish", onNavigate);

  // Layer 3: MutationObserver on the player bar title
  const observeTitle = () => {
    const el =
      document.querySelector("ytmusic-player-bar .title.ytmusic-player-bar") ||
      document.querySelector("ytmusic-player-bar #song-name");
    if (el) {
      new MutationObserver(onNavigate).observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } else {
      setTimeout(observeTitle, 1000);
    }
  };
  observeTitle();
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case "ROOM_CREATED":
      isHost = true;
      isInRoom = true;
      startPolling();
      break;

    case "ROOM_JOINED":
      isHost = false;
      isInRoom = true;
      break;

    case "APPLY_STATE":
      applyState(msg);
      break;

    case "HOST_LEFT":
      isInRoom = false;
      isHost = false;
      stopPolling();
      stopClientSync();
      removeUnlockOverlay();
      pendingState = null;
      pendingNavId = null;
      break;

    default:
      break;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  setupSPANavigation();

  // Reattach to room if the page was refreshed while we were connected
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (status) => {
    if (chrome.runtime.lastError || !status?.isInRoom) return;
    isInRoom = true;
    isHost = status.isHost ?? false;
    if (isHost) startPolling();
  });
}
