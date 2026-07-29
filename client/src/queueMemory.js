// Remembers a solo listener's queue in their own browser, so closing the tab (or the
// whole browser) doesn't lose what they were playing.
//
// localStorage, deliberately not cookies: a cookie is attached to every request to
// the server, so it would send this listener's music off the device continuously.
// localStorage never leaves the browser — the server only ever sees the queue that
// the listener's own session restores into it, which is the same data it already
// holds while they're connected.
//
// Nothing here identifies anyone: it stores track ids and titles and a position, no
// user id, no timestamps of use, no history of what was listened to.

const QUEUE_KEY = 'discord-music-activity-queue';
const PREF_KEY = 'discord-music-activity-remember-queue';

// A saved queue is capped so a long session can't grow without bound in storage.
const MAX_REMEMBERED_TRACKS = 300;

// On by default: keeping your own music is the point of the feature. Turning it off
// erases what's already stored (see setRememberQueue).
export function isRememberQueueEnabled() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return false;
  }
}

export function setRememberQueue(enabled) {
  try {
    localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off');
    if (!enabled) localStorage.removeItem(QUEUE_KEY);
  } catch {
    // Private mode or quota — the preference just won't stick.
  }
}

export function loadRememberedQueue() {
  if (!isRememberQueueEnabled()) return null;
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved?.queue) || saved.queue.length === 0) return null;
    return saved;
  } catch {
    return null;
  }
}

// Keeps only the fields needed to play the track again.
//
// An empty queue is never written here, and never erases what's stored: at startup
// the room is empty until the socket delivers its state, and treating that moment as
// "the queue is empty, forget it" would wipe the memory before it could be restored.
// Forgetting is always an explicit act — clearRememberedQueue().
export function saveRememberedQueue({ queue, currentIndex, currentService, position }) {
  if (!isRememberQueueEnabled()) return;
  if (!Array.isArray(queue) || queue.length === 0) return;
  try {
    const trimmed = queue.slice(0, MAX_REMEMBERED_TRACKS).map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist || '',
      thumbnail: track.thumbnail || '',
      service: track.service,
    }));
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({
        queue: trimmed,
        currentIndex: Math.min(Math.max(currentIndex ?? 0, 0), trimmed.length - 1),
        currentService: currentService === 'spotify' ? 'spotify' : 'youtube',
        position: Number.isFinite(position) && position > 0 ? position : 0,
      })
    );
  } catch {
    // ignore localStorage failure (private mode, quota, etc.)
  }
}

export function clearRememberedQueue() {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {
    // ignore
  }
}
