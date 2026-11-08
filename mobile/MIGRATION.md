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

Voice calls require a custom Expo development/release build because `react-native-webrtc` contains native code and is not included in Expo Go. The project includes the WebRTC config plugin, microphone permission, and `expo-dev-client` setup for that build path.

Push notifications also require a custom development/release build. The Expo project must have a project ID and Android/iOS push credentials configured before a device can receive production pushes.

## Next migration slices

1. Add people search and new-chat flow using `/search-users`.
2. Port groups, statuses, channels, starred messages, and account settings.
3. Add native image/audio pickers and adapt the existing data-URL upload limits.
4. Add call signaling UI on top of the existing `calls.js` events.
5. Add API URL configuration for local LAN, preview, and production builds.
