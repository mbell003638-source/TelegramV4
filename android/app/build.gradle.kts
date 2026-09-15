plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.agentos.client"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.agentos.client"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            // Left unminified by default so a locally built release APK behaves
            // identically to the debug one; the rules below apply if enabled.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = false
    }

    composeOptions {
        // Matches Kotlin 1.9.24 (see the root build file).
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")

    // Compose, versioned by the BOM.
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.activity:activity-compose:1.9.0")

    // ViewModel + Compose integration.
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")

    // Token + base URL persistence.
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Coroutines. All HTTP runs on Dispatchers.IO.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // HTTP is java.net.HttpURLConnection and JSON is org.json — both are part
    // of the Android platform, so there is no networking or parsing dependency.
    // Deliberately absent: Firebase, analytics, crash reporting.
}
