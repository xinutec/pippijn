plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.xinutec.life"
    compileSdk = 36
    // Pin to the build-tools the nix SDK provides (AGP would otherwise pick a
    // version that isn't in the read-only SDK).
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "org.xinutec.life"
        // minSdk 26 (Android 8): the system WebView is Chromium on any such device,
        // so the Angular dashboard renders as it does in Chrome.
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "0.5"
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
    // WebView is part of the framework — the only dependency is core-ktx. No
    // Compose, no AppCompat: this app is a single WebView.
    implementation(libs.androidx.core.ktx)
}
