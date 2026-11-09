# B-Messenger / gramX

B-Messenger is a real-data messaging platform with a Node.js, Express, MongoDB, and Socket.IO backend, a responsive browser/PWA client, and an Expo React Native client.

## Repository layout

- `server.js` — canonical Express and Socket.IO backend.
- `calls.js` — one-to-one WebRTC signaling, call lifecycle, TURN credential generation, and call history.
- `public/index.html` and `public/app.js` — primary browser/PWA client.
- `public/admin.html` — authenticated moderation console.
- `public/manifest.json`, `public/sw.js`, and `public/icon.svg` — PWA metadata and assets.
- `mobile/` — Expo TypeScript client, native configuration, push registration, media, offline private-message outbox, and WebRTC adapters.
- `docs/` — architecture and release verification notes.

`public/dex.html` and `mobile/NativeApp.tsx` are retained as historical/alternate implementations and are not the active entry points. The deployable backend is only `server.js`.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to a private environment file and provide a least-privilege MongoDB URI, a unique admin email, and an admin password of at least 16 characters. Never commit the private file.
3. Install backend dependencies and run checks:

```bash
npm ci
npm run check
npm run audit
npm start
```

The server intentionally refuses to start when `MONGODB_URI`, `ADMIN_EMAIL`, or `ADMIN_PASSWORD` is missing. It serves the browser client at `/`, the admin console at `/admin`, and readiness JSON at `/health`.

For the Expo client:

```bash
cd mobile
npm ci
npm run check
npm run doctor
EXPO_PUBLIC_API_URL=http://YOUR-LAN-IP:3000 npm start
```

A custom development/release build is required for `react-native-webrtc` and production push notifications; Expo Go is not evidence that those capabilities work.

## Runtime configuration

Required backend values are documented in `.env.example`. Production should also configure a TURN service through `TURN_URLS` and `TURN_SECRET`; STUN-only calls are not reliable across restrictive networks. The mobile release profiles point to the configured gramX API deployment in `mobile/eas.json`.

## Data and security model

MongoDB stores users, settings, messages, groups, statuses, channels, reports, password requests, admin logs, and call records. The server uses salted `scrypt` password hashes, opaque session tokens, Socket.IO authentication, account-status checks, Helmet security headers, bounded HTTP rate limits, and a fail-closed admin bootstrap.

The current media path uses validated, bounded data URLs inside MongoDB/Socket.IO. This is functional but remains a scale limitation; a production-scale deployment should migrate media to access-controlled object storage with content inspection, thumbnails, quotas, and lifecycle cleanup.

## Verification status

The following checks have been run in this workspace:

- Backend JavaScript syntax check: passed.
- Mobile TypeScript check: passed.
- Expo Doctor: 20/20 checks passed.
- Expo web export: passed.
- Production dependency audit excluding development tools: passed.
- Missing-secret startup fail-closed check: passed.

The following still require external infrastructure or devices and must not be represented as complete without evidence:

- MongoDB staging/production connectivity after credential rotation.
- Expo/APNs/FCM push delivery on physical devices.
- Two-device voice/video calls, including TURN traversal.
- EAS APK/AAB build, installation, signing, and checksum.
- Android 16 KB page-size inspection of every native `.so` library.
- Browser/mobile end-to-end tests against a staging database.

See [`docs/RELEASE.md`](docs/RELEASE.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the completion gates.
