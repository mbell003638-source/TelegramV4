# Android SDK local setup

Build the `android/` Gradle project on a developer machine. The scripts in this
directory install the command-line SDK only — they will **not** download a JDK
and they will **not** generate the Gradle wrapper.

If you just need a debug APK and do not want an SDK on this machine, skip this
file and use GitHub Actions (see [Lower-effort alternative](#lower-effort-alternative-github-actions)).

## Prerequisites: JDK 17+

`javac` 17 or newer must already be on `PATH`. The setup scripts refuse to
continue (they are not a no-op) if it is missing or too old.

**Windows** (pick one, then open a **new** terminal so PATH updates apply):

```text
winget install --id Microsoft.OpenJDK.17 -e --source winget
```

```text
winget install --id EclipseAdoptium.Temurin.17.JDK -e
```

Temurin 17 is what `.github/workflows/android-apk.yml` uses. Either build is
fine for this project.

**macOS:** `brew install --cask temurin@17`

**Linux:** a JDK 17+ devel package with `javac` on PATH (Eclipse Temurin 17, or
`java-17-openjdk-devel` / equivalent).

## Windows: `setup-android-sdk.ps1`

From the repo root. Dry-run first — it prints the plan and changes nothing:

```powershell
powershell -ExecutionPolicy Bypass -File android\tools\setup-android-sdk.ps1 -DryRun
```

Then install:

```powershell
powershell -ExecutionPolicy Bypass -File android\tools\setup-android-sdk.ps1
```

Optional: `-SdkRoot D:\Android\Sdk` to put the SDK somewhere other than the
default.

## What it installs, and where

Pinned **cmdline-tools revision `15859902`**, then these packages (matching
`compileSdk` / `targetSdk` 34 in `android/app/build.gradle.kts`):

| Package | On disk under the SDK root |
| --- | --- |
| `platform-tools` | `platform-tools/` (`adb`) |
| `platforms;android-34` | `platforms/android-34/` |
| `build-tools;34.0.0` | `build-tools/34.0.0/` |

Default SDK root (same as Android Studio):

- Windows: `%LOCALAPPDATA%\Android\Sdk`
- macOS: `~/Library/Android/sdk`
- Linux: `~/Android/Sdk`

The zip extracts to a folder named `cmdline-tools`. The scripts **move** that
inner folder to `cmdline-tools/latest` so `sdkmanager` can find itself. Do not
unzip the archive straight into `cmdline-tools/` — that double-nests and
sdkmanager fails.

After a successful run:

- **`ANDROID_HOME`** and **`ANDROID_SDK_ROOT`** point at the SDK root.
  - Windows: persisted as User environment variables (open a new terminal).
  - macOS/Linux: printed for the current shell; copy the three `export` lines
    into `~/.bashrc` or `~/.zshrc` if you want them to persist. The bash
    script does not silently edit rc files.
- **PATH** gains `platform-tools` (User PATH on Windows; printed `export` on
  Unix).
- **`android/local.properties`** is written with `sdk.dir` using **forward
  slashes** (Gradle treats `\` as an escape). That file is gitignored; re-run
  the script to refresh it rather than hand-editing.

The scripts are idempotent: re-running skips work that is already in place.

## Gradle wrapper (separate step)

The SDK scripts do not install Gradle and this repo does not commit
`gradle-wrapper.jar`. After the SDK is in place, from a **new** terminal:

```text
cd android
gradle wrapper
gradlew assembleDebug          # Windows: .\gradlew.bat assembleDebug
```

`gradle wrapper` needs a system `gradle` on PATH once; after that `gradlew`
bootstraps itself. Wrapper properties pin Gradle 8.7.

## Lower-effort alternative: GitHub Actions

[`.github/workflows/android-apk.yml`](../../.github/workflows/android-apk.yml)
builds a debug APK on push to `feat/**` and `master` (also `main`), and on
`workflow_dispatch`. No local SDK required. Download the `app-debug-apk`
artifact from the run.

## macOS / Linux: `setup-android-sdk.sh`

Same revision, same packages, same `cmdline-tools/latest` layout, same
`local.properties` write.

```bash
bash android/tools/setup-android-sdk.sh -n          # dry run
bash android/tools/setup-android-sdk.sh             # install
bash android/tools/setup-android-sdk.sh --sdk-root "$HOME/Android/Sdk"
```

Zip name is chosen from `uname`: `commandlinetools-linux-…`, or on macOS
`commandlinetools-mac_arm64-…` / `commandlinetools-mac_x86_64-…` (Google
publishes architecture-specific Mac archives for this revision).

The script exports `ANDROID_HOME` / `ANDROID_SDK_ROOT` / PATH for the process
it is running in. If you **sourced** it (`source android/tools/setup-android-sdk.sh`),
those exports stay in the current shell. If you **executed** it, they do not —
run the three `export` lines it prints, or add them to your rc file.

## Pin note

If `dl.google.com` 404s on
`commandlinetools-*-15859902_latest.zip`, Google has almost certainly shipped a
newer cmdline-tools build. Check the “Command line tools only” section of
https://developer.android.com/studio and bump `$CmdlineToolsRevision` /
`CMDLINE_TOOLS_REVISION` in both scripts to the new number.

## Signing

SDK setup does not configure release signing. See
[`android/signing/RELEASE.md`](../signing/RELEASE.md).
