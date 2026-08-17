// Whether the packaged Android app should hold a media session while playing.
//
// Turning it on registers with the OS: the track appears in the notification shade
// and on the lock screen with play/pause/skip, and a foreground service keeps
// playback from being reclaimed. That means a persistent notification, which is
// why it is the listener's choice rather than a default.
//
// Browsers don't need any of this — they get the standard Media Session API for
// free — so the preference only has meaning inside the app.

const PREF_KEY = 'background-playback';

export function isNativeApp() {
  return typeof window !== 'undefined' && !!window.Capacitor?.Plugins?.MediaSession;
}

// 'on' | 'off' | null (never asked)
export function readBackgroundPreference() {
  try {
    const value = localStorage.getItem(PREF_KEY);
    return value === 'on' || value === 'off' ? value : null;
  } catch {
    return null;
  }
}

export function writeBackgroundPreference(value) {
  try {
    localStorage.setItem(PREF_KEY, value ? 'on' : 'off');
  } catch {
    // Private mode / quota — the choice just won't persist.
  }
}
