import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "io.github.CyberTimon.RapidRAW"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "io.github.CyberTimon.RapidRAW"
        // The export path writes through MediaStore.Downloads and uses the
        // relative_path / is_pending columns, all of which only exist from
        // API 29; on older releases every export would fail, so Android 10 is
        // the real minimum.
        minSdk = 29
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }

    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                val keystoreProperties = Properties()
                keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
                
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            }
        }
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Fall back to the debug keystore when no keystore.properties is
            // present so local/CI builds without signing secrets still produce
            // an installable APK instead of failing on a null storeFile.
            signingConfig =
                if (rootProject.file("keystore.properties").exists()) {
                    signingConfigs.getByName("release")
                } else {
                    signingConfigs.getByName("debug")
                }

            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// rustls-platform-verifier's Kotlin component must exactly match the Rust
// crate resolved by cargo: the JNI protocol between them is not stable across
// versions, and a mismatch makes every HTTPS request fail with "error sending
// request". The official integration therefore serves the AAR bundled inside
// the rustls-platform-verifier-android cargo package via a local maven repo
// (see the crate README) instead of a remote registry.
val rustlsPlatformVerifierRepo = providers.exec {
    workingDir = rootDir.parentFile // src-tauri, where Cargo.toml lives
    commandLine(
        "cargo",
        "metadata",
        "--format-version",
        "1",
        "--filter-platform",
        "aarch64-linux-android",
    )
}.standardOutput.asText.get().let { metadata ->
    Regex("\"manifest_path\":\"([^\"]*rustls-platform-verifier-android[^\"]*Cargo\\.toml)\"")
        .find(metadata)?.groupValues?.get(1)
        ?.let { manifestPath -> File(manifestPath).parentFile.resolve("maven") }
}

repositories {
    if (rustlsPlatformVerifierRepo != null) {
        // Resolve the `rustls` group exclusively from the cargo-bundled
        // component; fall back to the defaults below only when the repo
        // cannot be located (e.g. cargo missing from PATH).
        exclusiveContent {
            forRepository {
                maven {
                    url = uri(rustlsPlatformVerifierRepo)
                    metadataSources { artifact() }
                }
            }
            filter { includeGroup("rustls") }
        }
    }
    google()
    mavenCentral()
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("rustls:rustls-platform-verifier:0.1.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")