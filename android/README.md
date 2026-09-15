# Agent OS Android client

A thin Jetpack Compose client (`com.agentos.client`) for the Mission Control
gateway that `node index.js` serves on port 3141. It is not a second backend
and it does not spawn agents of its own.

HTTP is `java.net.HttpURLConnection` and JSON is `org.json` — both ship with
the platform. There is no Firebase, no analytics, and no crash reporting.

The token field is the gateway's `DASHBOARD_TOKEN`. DataStore writes it to
app-private storage (`/data/data/com.agentos.client/files/datastore`). That is
not encrypted at rest; on a rooted or unlocked device it is readable.

## Tabs

Five sibling tabs, no back stack:

| Tab | What it talks to |
|---|---|
| **Connect** | Gateway origin + `DASHBOARD_TOKEN`. `GET /api/info` is the connection test. |
| **Agents** | `GET /api/agents` plus the per-agent OmniRouter switch (`POST /api/agents/override`). One agent per request; there is no master switch. |
| **Chat** | `POST /api/chat/send` queues a turn. The reply arrives later over `GET /api/chat/stream` (SSE). A 2xx on send is not an answer. |
| **Remote** | `GET /api/devices` / `GET /api/devices/remote` and `POST /api/devices/action`. Named remote keys for phones and Android TV / Google TV (`adb connect`). |
| **Memory** | `GET /api/memories/search` against the shared store every agent reads and writes. |

## Requirements

- **minSdk** 26 (Android 8.0)
- **compileSdk** / **targetSdk** 34
- **JDK** 17 (`sourceCompatibility` / `jvmTarget` 17)

Debug APKs permit cleartext so a sideloaded build can reach a gateway on your
LAN. The release network-security config is HTTPS-by-default, with a short
allow-list of loopback / emulator / common private IPs. If your gateway sits
on some other private address, add that literal to
`app/src/main/res/xml/network_security_config.xml` and rebuild.

## Debug APK

### CI (no local SDK)

[`.github/workflows/android-apk.yml`](../.github/workflows/android-apk.yml)
runs on pushes that touch `android/**` (and on `workflow_dispatch`). It
installs JDK 17, generates the Gradle wrapper if `gradle-wrapper.jar` is
missing, runs `./gradlew assembleDebug`, and uploads
`android/app/build/outputs/apk/debug/*.apk` as the `app-debug-apk` artifact.

Download that APK from the workflow run and sideload it.

### Local SDK

The repo does not vendor the Android SDK or `gradle-wrapper.jar`. See
[`tools/SDK_SETUP.md`](tools/SDK_SETUP.md) for the full picture.

On Windows the one-shot path is:

```powershell
powershell -ExecutionPolicy Bypass -File android\tools\setup-android-sdk.ps1
cd android
gradle wrapper          # once; needs `gradle` on PATH (or open the project in Android Studio)
.\gradlew.bat assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/`.

## Release signing

Release keystores and the Gradle signing config live outside this file. See
[`signing/RELEASE.md`](signing/RELEASE.md).
