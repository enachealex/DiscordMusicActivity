import { useEffect, useState } from 'react';
import './InstallAppBanner.css';

const DISMISS_KEY = 'install-banner-dismissed';

// Already running as an installed app? Capacitor injects window.Capacitor in the
// Android APK; iOS home-screen launches report navigator.standalone; installed
// PWAs elsewhere match display-mode: standalone.
function isInstalled() {
  if (window.Capacitor) return true;
  if (window.navigator.standalone) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

// iPadOS reports itself as a Mac, so the touch-point count is the tell.
function isIos() {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function detectPlatform() {
  if (typeof navigator === 'undefined' || isInstalled()) return null;
  if (isIos()) return 'ios';
  if (/android/i.test(navigator.userAgent)) return 'android';
  return null;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Mobile-web-only prompt to install the app.
 *
 * Android gets the real APK. iOS has no sideloading, so it gets the
 * Add-to-Home-Screen route instead — Safari can't be triggered into that
 * programmatically, so the button just reveals the two steps.
 */
export default function InstallAppBanner() {
  const [platform] = useState(detectPlatform);
  const [apk, setApk] = useState(null);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  useEffect(() => {
    if (dismissed || platform !== 'android') return;
    let cancelled = false;
    fetch('/api/download/android/meta')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.available) setApk(data);
      })
      .catch(() => {
        // No APK published on this server — leave the banner hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed, platform]);

  if (dismissed || !platform) return null;
  // Android only offers the banner once the server confirms an APK exists.
  if (platform === 'android' && !apk) return null;

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  const size = platform === 'android' ? formatSize(apk.sizeBytes) : '';

  return (
    <div className="install-banner">
      <div className="install-banner-row">
        <svg className="ib-icon" viewBox="0 0 100 100" width="34" height="34" aria-hidden="true">
          <circle cx="50" cy="50" r="48" fill="#18191c" />
          <circle cx="50" cy="50" r="40" fill="none" stroke="#3a3b40" strokeWidth="1.5" />
          <circle cx="50" cy="50" r="32" fill="none" stroke="#3a3b40" strokeWidth="1.5" />
          <circle cx="50" cy="50" r="22" fill="#5865f2" />
          <text x="50" y="57" textAnchor="middle" fontSize="20" fill="white" fontFamily="sans-serif">
            ♪
          </text>
        </svg>

        <div className="ib-text">
          <div className="ib-title">
            {platform === 'android' ? 'Get the Android app' : 'Add to your Home Screen'}
          </div>
          <div className="ib-sub">
            {platform === 'android' ? `APK · ${size}` : 'Runs full screen, like an app'}
          </div>
        </div>

        {platform === 'android' ? (
          <a className="ib-action" href="/api/download/android" download>
            Download
          </a>
        ) : (
          <button className="ib-action" onClick={() => setShowIosSteps((v) => !v)}>
            {showIosSteps ? 'Hide' : 'How'}
          </button>
        )}

        <button className="ib-close" onClick={dismiss} aria-label="Hide install prompt">
          ×
        </button>
      </div>

      {platform === 'ios' && showIosSteps && (
        <ol className="ib-steps">
          <li>
            Tap <strong>Share</strong> in Safari's toolbar (the box with an arrow).
          </li>
          <li>
            Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
        </ol>
      )}
    </div>
  );
}
