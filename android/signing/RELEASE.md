# Release signing

This directory holds the **template** for release-signing the AgentOS Android
client (`com.agentos.client`). The real keystore and the filled-in properties
file must never live in git.

Local SDK install (JDK, Android SDK, `local.properties`) is documented in
[`android/tools/SDK_SETUP.md`](../tools/SDK_SETUP.md). This runbook assumes
that is already done and `keytool` from a **JDK 17+** is on `PATH`.

## Generate a keystore

Run from the `android/` directory (the Gradle root). Do not invent a password
here — `keytool` will prompt, and you type one you will actually keep.

```
keytool -genkeypair -v -keystore signing/agentos-release.jks -alias agentos -keyalg RSA -keysize 2048 -validity 10000 -storetype JKS
```

Constraints:

* **JDK 17+** (`keytool -help` is enough to confirm it is the right one).
* **RSA, 2048 bits or more** (`-keyalg RSA -keysize 2048`).
* **At least 10 000 days** of validity (`-validity 10000` is ~27 years).
* **Alias `agentos`**, matching `keyAlias` in the properties template.

`keytool` asks for a keystore password, a key password, and a Distinguished
Name. Remember both passwords; there is no recovery path if they are lost.
The `.jks` file is created at `android/signing/agentos-release.jks`, which is
gitignored.

## Fill in `keystore.properties`

```
copy signing\keystore.properties.example signing\keystore.properties
```

On Unix: `cp signing/keystore.properties.example signing/keystore.properties`.

Open `signing/keystore.properties` and set:

* `storeFile` — leave as `signing/agentos-release.jks` unless you stored the
  keystore somewhere else. The path is relative to `android/`.
* `storePassword` — the keystore password you typed into `keytool`.
* `keyAlias` — `agentos` unless you chose a different `-alias`.
* `keyPassword` — the key password you typed into `keytool`.

## How Gradle applies this

[`android/app/build.gradle.kts`](../app/build.gradle.kts) loads
`signing/keystore.properties` **only if that file exists**:

* If it exists, a `release` signing config is created and attached to the
  `release` build type. `./gradlew assembleRelease` then produces a signed APK.
* If it does not exist, `release` still configures and builds, unsigned /
  using AGP defaults. A fresh checkout and CI keep working.
* **Debug APKs always use the default Android debug key.** Presence of
  `keystore.properties` does not change `assembleDebug`.

`storeFile` is resolved from the `android/` Gradle root with backslashes
normalized to forward slashes, so the same properties file works on Windows
and Unix.

## Never commit signing material

Do not commit any of:

* `*.jks` / `*.keystore` / `*.p12`
* `signing/keystore.properties` (the filled-in file)
* passwords, in this repo or in chat logs or screenshots

`android/signing/.gitignore` and `android/.gitignore` already ignore those.
The tracked file is only `keystore.properties.example` (empty passwords).

A force-push after a leak does **not** undo it. Anyone who cloned or fetched
in between still has the bytes.

## A leaked keystore or password is unrecoverable

The keystore plus its passwords **are** the app's signing identity.

**If you are the one signing what devices verify** (sideloaded APKs, or a Play
listing that is *not* enrolled in Play App Signing): there is no rotation.
Anyone with the leaked file can ship APKs that Android treats as updates to
`com.agentos.client`. You cannot take that ability back. The only way out is
a new `applicationId` and a new listing; existing installs will not update.

**If the app is enrolled in Play App Signing:** Google holds the *app signing
key* (what devices verify). You hold an *upload key* (what you use to sign
the AAB/APK you send to Play). A leaked **upload** keystore can be reset in
Play Console after identity checks; Play will accept a new upload key and
re-sign with the app signing key it already holds. A leaked **app signing**
key (you exported it, or you never enrolled and this `.jks` *is* that key)
cannot be reset. Treat a leak as a full compromise either way and rotate the
upload key immediately if Play App Signing is in use.

Losing the passwords is the same as losing the file: you will not be able to
sign further updates with that key.

## CI stays debug-only

[`.github/workflows/android-apk.yml`](../../.github/workflows/android-apk.yml)
runs `./gradlew assembleDebug` and uploads that APK. It must stay that way
unless release keystore material is later added as GitHub Actions secrets
**and** the workflow is deliberately changed to `assembleRelease`. Do not
point CI at `keystore.properties` on the runner; that file is not in the
repo, and baking passwords into the workflow is how they leak.

Until that happens, the artifact from Actions is a **debug** APK, signed with
the public Android debug key, not this release keystore.
