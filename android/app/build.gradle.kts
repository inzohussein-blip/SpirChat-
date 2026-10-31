plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.spirchat.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.spirchat.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        // Internet hubs the app connects to by default (comma separated), e.g. https://hub.example.org
        buildConfigField("String", "INTERNET_HUBS", "\"" + (System.getenv("SPIRCHAT_INTERNET_HUBS") ?: "") + "\"")
    }

    // A fixed release key lets people update without uninstalling (which would wipe their data)
    // and lets them check that an APK is genuine. CI provides it through repository secrets.
    val keystore = System.getenv("SPIRCHAT_KEYSTORE")?.takeIf { it.isNotBlank() }?.let(::file)?.takeIf { it.exists() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("SPIRCHAT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SPIRCHAT_KEY_ALIAS") ?: "spirchat"
                keyPassword = System.getenv("SPIRCHAT_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
    }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

// The UI is the same web app the hubs serve (../web), bundled so the app works with no hub at all.
val copyWebApp by tasks.registering(Copy::class) {
    val dist = rootProject.file("../web/dist")
    doFirst {
        check(dist.resolve("index.html").exists()) { "web app not built: run `npm run build` in the repository root first" }
    }
    from(dist)
    into(layout.buildDirectory.dir("generated/webassets/web"))
}
tasks.named("preBuild") { dependsOn(copyWebApp) }

dependencies {
    implementation(project(":engine"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.gms:play-services-nearby:19.3.0")
}
