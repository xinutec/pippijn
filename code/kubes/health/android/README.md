# health web viewer (Android)

The `health.xinutec.org` dashboard presented as a native-feeling app: a single
full-screen **WebView**, no address bar, no tabs, a home-screen icon. It avoids
browser chrome while showing the dashboard exactly as designed (the system WebView
is Chromium, so it renders like Chrome).

The site is **behind a login** (Nextcloud OAuth, a self-hosted IdP that works in a
WebView). The WebView keeps the session cookie, so it's a **one-time sign-in**; the
app needs only `INTERNET`.

## What it does

- Loads `https://health.xinutec.org/` — **hardcoded** (`MainActivity.HEALTH_URL`);
  this app is single-purpose.
- JavaScript + DOM storage on (Angular), all navigation kept in-app, Back walks the
  SPA history.
- Edge-to-edge: the dashboard handles the system-bar inset itself via CSS
  `env(safe-area-inset-top)` (`viewport-fit=cover`), so the wrapper adds no padding;
  the area behind the status bar is black to match the dark UI.

Runs on any Android 8+ (minSdk 26) device.

## Build & install

No toolchain lives in this repo — it borrows the recall project's `android` nix
dev shell (JDK 17 + Android SDK; the Gradle wrapper pins Gradle):

```sh
cd android
nix develop ~/Code/recall#android --command ./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Install onto a phone over WiFi (Pixel 9 is at `192.168.1.133:5555`):

```sh
ADB="$ANDROID_HOME/platform-tools/adb"   # inside the nix shell above
"$ADB" connect 192.168.1.133:5555
"$ADB" -s 192.168.1.133:5555 install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s 192.168.1.133:5555 shell am start -n org.xinutec.health/.MainActivity
```

The APK is signed with the auto-generated debug key — fine for sideloading, the
only distribution path.

## Layout

```
android/
├── app/
│   ├── build.gradle.kts                          # android app module, no Compose/AppCompat
│   └── src/main/
│       ├── AndroidManifest.xml                   # INTERNET; single launcher activity
│       ├── kotlin/org/xinutec/health/MainActivity.kt  # the WebView
│       └── res/                                  # launcher icon (pink heart), theme, strings
├── build.gradle.kts · settings.gradle.kts · gradle/   # project scaffolding
└── gradlew                                       # borrows ~/Code/recall#android for the SDK
```
