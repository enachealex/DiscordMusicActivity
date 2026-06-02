// Single source of truth for saved playlists, persisted in localStorage.
//
// Both Queue.jsx and Search.jsx read and write playlists. The browser's native
// `storage` event only fires in *other* tabs/windows, never the tab that made the
// change, so two components in the same tab would otherwise drift out of sync (e.g.
// add to a playlist from the Queue, but the Search "Add to Playlist" list never
// updates). This store dispatches a same-tab `playlists:changed` event on every
// write so every subscriber refreshes immediately, and also listens for the
// cross-tab `storage` event so multiple tabs stay consistent.

const STORAGE_KEY = 'discord-music-activity-playlists';
const CHANGE_EVENT = 'playlists:changed';

export function loadPlaylists() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function savePlaylists(playlists) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
  } catch {
    // ignore localStorage failure (private mode, quota, etc.)
  }
  // Notify same-tab subscribers; `storage` won't fire for this tab.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { playlists } }));
}

// Subscribe to playlist changes from anywhere (this tab or others). Returns an
// unsubscribe function. The callback receives the latest playlists array.
export function subscribePlaylists(callback) {
  function onLocalChange(event) {
    callback(event.detail?.playlists ?? loadPlaylists());
  }
  function onStorage(event) {
    if (event.key !== STORAGE_KEY) return;
    callback(loadPlaylists());
  }
  window.addEventListener(CHANGE_EVENT, onLocalChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocalChange);
    window.removeEventListener('storage', onStorage);
  };
}
