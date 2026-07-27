# Android app (`mobile/`)

A [Capacitor](https://capacitorjs.com) shell that runs the live web app —
`https://discordmusic.thejumpvault.com` — as an installable Android app.

The APK contains no copy of the UI. It loads the same site the browser does
(`server.url` in `capacitor.config.json`), so **anything you deploy to the server
appears in the app immediately — no rebuild, no reinstall.** You only rebuild the
APK to change native things: app name, icon, permissions, target SDK.

That is the right shape here because the app can't work offline anyway: the queue,
DJ state, search, and YouTube audio all live on the server behind Socket.IO.

## Build the APK

Requires JDK 21 (Android Studio bundles one at `jbr/`) and the Android SDK.

```bash
cd mobile/android && ./gradlew assembleDebug
```

On Windows, if `JAVA_HOME` isn't set:

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat assembleDebug
```

Output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (~5 MB).

Install it by copying the file to a phone and opening it (allow "install unknown
apps" for whatever app opens it), or over USB with `adb install -r <apk>`.

A debug APK is signed with the shared Android debug key. That's fine for
sideloading to your own devices. For a Play Store upload or a stable
update-in-place identity, sign a release build with your own keystore — see
"Release signing" below.

## Publishing the APK to the website

Mobile web visitors on Android see a "Get the Android app" banner that downloads
this APK from the server. To ship a new build:

```bash
cd mobile/android && ./gradlew assembleDebug
cd .. && npm run publish:apk        # copies it to server/downloads/JumpVaultMusic.apk
```

Then commit `server/downloads/JumpVaultMusic.apk` and deploy — `recover.sh` pulls
it with the rest of the repo. The server exposes it at `/download/android`, and
`/download/android/meta` reports whether it exists, so a server without the file
simply shows no banner instead of a broken link.

Add `release` to publish a signed build instead: `npm run publish:apk -- release`.

## iOS

There's no APK equivalent — Apple doesn't allow sideloading. iPhone users install
the site as a home-screen web app instead (Safari → Share → Add to Home Screen),
which the mobile banner walks them through. That path is powered by
`client/public/manifest.webmanifest` and the `apple-*` meta tags in
`client/index.html`; no build step and nothing in this folder is involved.

A native iOS build would need a Mac, Xcode, and a paid Apple Developer account
($99/yr) even for TestFlight — `npx cap add ios` is the starting point if that
ever becomes worth it.

## Icons and splash

`assets/vinyl.svg` is the source mark (the client's `favicon.svg`, with the ♪
redrawn as paths so rasterising doesn't depend on an installed font). One command
regenerates both the Android launcher icons and the website's PWA / Apple
touch icons, so the app and the home-screen shortcut always match:

```bash
npm run icons
```

That runs `scripts/gen-icons.mjs` (SVG → PNGs in `assets/` and `client/public/`)
followed by `capacitor-assets generate --android` (PNGs → `android/app/src/main/res/**`).

## Changing the server it points at

Edit `server.url` and `server.allowNavigation` in `capacitor.config.json`, then:

```bash
cd mobile && npx cap sync android
```

For local testing against a dev machine, point `server.url` at
`http://<your-lan-ip>:3001` and set `"cleartext": true` (plain HTTP is blocked
otherwise). Don't ship that.

## Native tweaks that matter

- [`MainActivity.java`](android/app/src/main/java/com/thejumpvault/discordmusic/MainActivity.java)
  routes `target="_blank"` links (Spotify sign-in, "Add to Discord") to the system
  browser. A plain WebView ignores those clicks. Spotify's token still comes back
  to the app because the server emits it over Socket.IO to the originating socket
  id, not just via the popup's `window.opener`.
- Capacitor already disables the WebView's media-gesture requirement, so autoplay
  works without extra config.
- `www/offline.html` is shown if the server can't be reached (`server.errorPath`).

## Known limits

- **Background audio is best-effort.** Audio keeps playing when you leave the app,
  but Android can reclaim the process at any time, and there are no lockscreen or
  notification controls. Fixing that properly needs a foreground service plus the
  web app calling the Media Session API.
- **Spotify playback needs Premium**, same as on the web.
- This wraps a website, so Google Play's "minimum functionality" policy may reject
  it as-is. Sideloading is unaffected.

## Release signing

Generate a keystore yourself (pick your own password — don't reuse one):

```bash
keytool -genkey -v -keystore mobile/android/app/release.keystore -alias jumpvault -keyalg RSA -keysize 2048 -validity 10000
```

Then add `signingConfigs` to `android/app/build.gradle` referencing it and run
`./gradlew assembleRelease`. Keep the keystore backed up — losing it means you can
never update an installed app in place.
