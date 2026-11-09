# Architecture

## Request and data flow

```text
Browser/PWA or Expo client
        │
        ├── HTTP: auth, users, search, push tokens, admin, health
        └── Socket.IO: chats, groups, statuses, presence, receipts, calls
                │
                ▼
        server.js + calls.js
                │
                ├── MongoDB collections and indexes
                ├── Expo push service
                └── STUN/TURN configuration for WebRTC signaling
```

## Authentication

The current application uses opaque bearer session tokens rather than JWTs. Browser sessions are stored in local storage and mobile sessions in AsyncStorage. The backend now requires explicit environment-provided admin credentials, rejects weak admin bootstrap passwords, checks account status during HTTP and Socket.IO authentication, and applies bounded rate limits to authentication and HTTP API surfaces.

This is safer than the former default-password behavior, but a full multi-device session model with expiry, rotation, hashed session records, re-authentication, and user self-service reset tokens remains a future hardening slice.

## Client surfaces

The supported browser client is `public/index.html` plus `public/app.js`. The supported mobile entry is `mobile/index.ts` → `mobile/App.tsx`. The admin console is a separate authenticated surface at `/admin`. Legacy alternate clients are not part of the release path.

## Persistence

MongoDB indexes are created at startup for users, settings, messages, statuses, groups, channels, reports, password requests, and starred messages. Statuses use a TTL index. Call records are persisted, while active call occupancy and signaling timers remain process-local; multi-instance deployment therefore requires shared Socket.IO/presence/call state before horizontal scaling.

## Media and calls

Messages, profiles, statuses, groups, and channel posts currently accept bounded image/audio data URLs. WebRTC media is peer-to-peer where possible; the server relays only signaling. Configure and test TURN before calling voice/video production-ready.
