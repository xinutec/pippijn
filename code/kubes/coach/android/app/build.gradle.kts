plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.xinutec.coach"
    compileSdk = 36
    // Pin to the build-tools the nix SDK provides (AGP would otherwise pick a
    // version that isn't in the read-only SDK).
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "org.xinutec.coach"
        // minSdk 26 (Android 8): the system WebView is Chromium on any such device,
        // so the Angular app renders as it does in Chrome.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        // Sideloaded build — no shrinking, signed with the debug key for simplicity.
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // The UI is a single WebView (framework), so the only extras are core-ktx and
    // Play Services location for the home geofence + set-home flow.
    implementation(libs.androidx.core.ktx)
    implementation(libs.play.services.location)
}
