# coach (Android)

The `coach.xinutec.org` app presented as a native app — a full-screen **WebView**,
no address bar, a home-screen icon — **plus** a native **home geofence** that nudges
you to train when you're home.

The site is behind Nextcloud-identity login; the WebView keeps the session cookie,
so it's a one-time sign-in.

## Two layers

**WebView** (`MainActivity`) — loads `https://coach.xinutec.org/` (hardcoded in
`Config.BASE_URL`), JS + DOM storage on, navigation confined to the app + its NC
login hop, Back walks the SPA history, system-bar strips painted with the page's
own surface colour.

**Native geofence** — a "Reminders" button (bottom-left) records your **home
location on-device** (`Prefs` / SharedPreferences — never sent to the server or
committed to source; it's your location) and arms a `GeofencingClient` geofence.
When you settle at home, `GeofenceBroadcastReceiver` calls `GET /api/pacing/now`
(reusing the WebView's session cookie) and posts a reminder **only if the backend
says `nudge`** — the backend already applies the window / night-cutoff / spacing
gates, so the phone stays a thin trigger. `BootReceiver` re-arms after a reboot.

Permissions requested when you turn reminders on: fine location → background
location ("Allow all the time", required for the geofence to fire while the app is
closed) → notifications.

Runs on any Android 8+ (minSdk 26).

## Build & install

Borrows the recall project's `android` nix dev shell (JDK 17 + Android SDK; the
Gradle wrapper pins Gradle). Install targets the Pixel 9 only (keys on device
model, not IP):

```sh
cd android
nix develop ~/Code/recall#android --command ./deploy.sh   # build + install to the Pixel 9
# or just build:
nix develop ~/Code/recall#android --command ./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

The APK is signed with the auto-generated debug key — fine for sideloading, the
only distribution path.

## Layout

```
android/
├── app/src/main/
│   ├── AndroidManifest.xml                      # WebView activity + geofence/boot receivers
│   ├── kotlin/org/xinutec/coach/
│   │   ├── MainActivity.kt                       # WebView + reminders setup flow
│   │   ├── Config.kt · Prefs.kt                  # constants + on-device home/armed state
│   │   ├── Geofencing.kt                         # arm/remove the home geofence
│   │   ├── GeofenceBroadcastReceiver.kt          # on home → query pacing → notify
│   │   ├── BootReceiver.kt                       # re-arm after reboot
│   │   ├── PacingClient.kt · Notifications.kt    # authenticated GET + the reminder
│   │   └── ...
│   └── res/                                      # launcher icon, theme, notification icon
├── build.gradle.kts · settings.gradle.kts · gradle/
└── deploy.sh                                     # build + adb install to the Pixel 9
```
