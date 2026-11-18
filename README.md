# US & Always — Web App

The web version of the US & Always couple app: the same features, the same
Supabase backend, the same end-to-end encryption and the same two designs
(Warm Editorial / Dark Luxe) as the Android app (v1.1.2), plus a third
web-only design (Morning Cream) — running in a browser instead of as an
installed APK, so both partners can test it live.

## How to open it

It is a plain static site — no build step, no server code. Serve this
folder over HTTPS (or open it through any static host) and visit
`index.html`:

```sh
cd web/
python3 -m http.server 8901
# then open http://localhost:8901/  (on the same machine)
```

For the couple's phones, put the folder on any HTTPS static host (for
example the deployment prepared under `../deploy/web/`) and open the URL
on each phone. In the browser menu, choose **“Add to Home Screen”** to
open it like an app (a `manifest.webmanifest` and icon are included).

> HTTPS matters: the encryption, microphone, notifications and
> “add to home screen” features only work on secure origins
> (`localhost` counts as secure for testing on the same machine).

## How it works

- **Backend:** the couple's own Supabase project
  (`https://nuftteaifpafarmhqdtd.supabase.co`), exactly like the Android
  app. The public anon key is baked into `js/api.mjs`; Row Level Security
  limits every account to its own couple.
- **Encryption (identical wire format to Android):** X25519 key agreement
  (@noble/curves), HKDF-SHA256 with salt `USAndAlways-E2EE-v1` and the
  message id as info, AES-256-GCM (WebCrypto). Chat messages, voice
  notes, photos, books, album captions, bucket titles, check-in notes,
  gift notes, conflict answers and the room status line are all sealed
  on the device; the server only ever stores ciphertext. A message
  written in this web app can be opened by the Android app and vice
  versa — proven by `tests/crypto_crosscheck.mjs` (20/20 checks against
  an independent implementation of the Android spec).
- **Your key:** generated in the browser, encrypted under your account
  password (PBKDF2-HMAC-SHA256, 120,000 iterations + AES-GCM) and stored
  only in this browser's local storage. It is never sent anywhere. If
  you sign in on a new browser, a fresh key is created there and
  published, and the app tells you to compare safety numbers again
  (Settings → Security).
- **Remote config:** the same `app_config` table as Android — theme
  palettes, truth/dare prompts, conflict questions, gift kinds, the
  announcement banner and the `features.connection_service` flag are
  applied without any code change.

## Honest platform notes (also stated inside the app)

- **No home-screen widget on the web** — the Home tab shows the same
  information (partner, days together, streak, battery, check-ins).
- **Notifications are poll-based while the page is open** (every few
  seconds). There is no push: when the page is closed, nothing arrives
  until it is opened again.
- **Scheduled and surprise messages send while the page is open** —
  the same limit the Android app states.
- **Arrival** is a manual “I reached” button: the web cannot check your
  location in the background. Your saved place's coordinates are never
  shared — only its name, when you tap the button.
- **Listen/Watch Together** plays direct audio/video file links only
  (no Netflix/YouTube), exactly like Android.
- Voice notes recorded in a browser play in browsers; an Android-recorded
  voice note may not play in every browser (different recording formats).

## Files

| File | What it is |
|---|---|
| `index.html` | The app shell (all screens are rendered by the JS modules) |
| `css/app.css` | Design system — both UiTheme palettes as CSS variables |
| `js/app.js` | Core: auth, key unlock, PIN lock, Home, Chat, Voice Notes, Settings, global polling |
| `js/features.mjs` | Games (Tic Tac Toe, Ludo, Spin, Pet), Together (Playlist, Listen/Watch, Draw, Read), Memories (Album, Journey, Bucket, Memories, Check-in, Conflict, Gifts), Couple Room |
| `js/crypto.mjs` | The E2EE core (environment-agnostic; imported by the tests) |
| `js/api.mjs` | Supabase Auth/REST/RPC/Storage over plain `fetch` |
| `js/vendor/noble.mjs` | Pre-bundled @noble/curves + @noble/hashes (vetted crypto primitives; bundled once at build time so the app itself needs no build step) |
| `manifest.webmanifest`, `icon.svg` | “Add to Home Screen” support |
| `tests/crypto_crosscheck.mjs` | Web ↔ Android-spec crypto compatibility proof — `node tests/crypto_crosscheck.mjs` |
| `tests/live_test.mjs` | Two-user live test against the real backend — `node tests/live_test.mjs` (creates and deletes its own throwaway users) |
