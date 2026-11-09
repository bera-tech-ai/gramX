# GramX Expo migration

The original GramX web client remains in `../public` and the MongoDB/Socket.IO server remains in `../server.js`. The Expo client is intentionally isolated in this directory so the web app can continue to run while mobile parity is added incrementally.

## Current slice

- Expo TypeScript app with GramX dark visual language.
- Login and registration against the existing `/login`, `/register`, `/session`, and `/logout` endpoints.
- Socket.IO authentication using the existing `{ username, token }` handshake contract.
- Conversation list using `get-conversations`.
- Private chat history using `join-conversation`.
- Text messaging using `send-private-message` with realtime updates.
- Local session persistence using AsyncStorage.
- Voice calls using the existing Socket.IO signaling contract plus native WebRTC offer/answer/ICE handling.
- Incoming-call overlay with answer, decline, and end-call controls.
- Background incoming-call push notifications using Expo push tokens, Android `calls` channel setup, and notification-tap call restoration.
- Groups, statuses, image/audio messages, reactions, edits, starring, offline private-message outbox, and voice/video call UI in the active `App.tsx` entry point.

Voice/video calls require a custom Expo development/release build because `react-native-webrtc` contains native code and is not included in Expo Go. The project includes the WebRTC config plugin and microphone/camera permissions; `expo-dev-client` is not a declared dependency in this checkout.

Push notifications also require a custom development/release build. The Expo project must have a project ID and Android/iOS push credentials configured before a device can receive production pushes.

## Remaining parity slices

1. Port channels/explore, starred history, full profile/privacy controls, reports, blocking/muting, and complete contact search semantics.
2. Replace the calls-tab conversation approximation with real `get-calls` history.
3. Add durable group-message/media queues and screen-level offline/retry states.
4. Add explicit Android artifact inspection and two-device push/WebRTC validation.
5. Migrate large media from data URLs to validated object storage before scale-out.
