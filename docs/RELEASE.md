# Release checklist

## Required before deployment

- Rotate any MongoDB and admin credentials that were ever stored in the old tracked `.env`; remove the secret file from the repository and complete the approved history cleanup separately.
- Configure a separate staging MongoDB database and verify TLS, least privilege, indexes, TTL behavior, backups, and restore procedures.
- Configure a managed TURN service and keep `TURN_SECRET` outside source control.
- Deploy behind HTTPS with WebSocket upgrade support and persistent logs.
- Confirm `/health` returns HTTP 200 only after MongoDB connection and admin bootstrap succeed.

## Backend checks

```bash
npm ci
npm run check
npm run audit
```

Run registration, login, logout, account-status, group, status, message, media, report, admin, and Socket.IO contract tests against staging. Do not run destructive tests against production data.

## Mobile checks

```bash
cd mobile
npm ci
npm run check
npm run doctor
npm run export:web
```

Create an EAS preview APK, install it on a real Android device, and verify login, messaging, offline retry, media, push, voice calls, video calls, permissions, backgrounding, and notification taps. Then create the production AAB with an incremented `versionCode`.

## Android 16 KB verification

For the generated release APK/AAB, inspect every native library:

```bash
unzip -l app-release.apk | grep -E 'lib/.+\\.so'
zipalign -c -P 16 -v 4 app-release.apk
$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf -lW path/to/library.so
```

Install on an Android 15/16 KB-page-size environment and exercise WebRTC, audio, camera, notifications, and app restart. The Expo configuration setting is preparation only; an artifact inspection and device run are the evidence.

## Honest status rule

Do not claim APK availability, database connectivity, push delivery, TURN traversal, WebRTC success, or 16 KB compatibility from configuration alone. Attach the artifact, command output, device model/OS, and test date to the release record.
