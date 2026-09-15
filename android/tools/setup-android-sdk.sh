#!/usr/bin/env bash
# Sets up everything needed to build the android/ Gradle project locally on
# macOS or Linux: a check for a JDK 17+, the Android command-line tools, the
# platform-tools/platforms/build-tools packages this project needs, and
# android/local.properties.
#
# Idempotent: safe to re-run. Every step first checks whether its result is
# already in place and skips the work if so. Nothing is downloaded or
# installed silently -- a missing JDK stops the script with the exact
# command to install one, and every download/install step verifies its own
# result and exits instead of continuing on a partial failure.
#
# This script does NOT install a JDK and does NOT install Gradle itself.
# It does NOT silently edit ~/.bashrc / ~/.zshrc; it prints the exact
# ANDROID_HOME / PATH lines to add. See android/tools/SDK_SETUP.md.
#
# Usage:
#   bash android/tools/setup-android-sdk.sh -n          # dry run
#   bash android/tools/setup-android-sdk.sh --dry-run
#   bash android/tools/setup-android-sdk.sh
#   bash android/tools/setup-android-sdk.sh --sdk-root "$HOME/Android/Sdk"
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Android SDK command-line tools revision. Pinned to a specific build number
# because "latest.zip" is a moving target and a script that silently follows
# it can start behaving differently with no code change of its own.
#
# 15859902 confirmed current as of 2026-09-15 from the "Command line tools
# only" section of https://developer.android.com/studio (filenames
# commandlinetools-win-15859902_latest.zip / -mac_arm64- / -mac_x86_64- /
# -linux-), cross-checked against the Homebrew "android-commandlinetools"
# cask, which tracks the same build number independently.
#
# If dl.google.com starts 404-ing on this URL, that almost certainly means
# Google has shipped a newer revision -- check the URL above and bump the
# number below.
CMDLINE_TOOLS_REVISION='15859902'

# Matches android/app/build.gradle.kts: compileSdk = 34, targetSdk = 34.
PLATFORM_PACKAGES=(platform-tools 'platforms;android-34' 'build-tools;34.0.0')

MIN_JDK_MAJOR=17
MIN_ZIP_BYTES=$((50 * 1024 * 1024))  # real download is ~155 MB; anything far smaller is a truncated/failed download or an HTML error page.

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  C_CYAN=$'\033[36m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_GRAY=$'\033[90m'
  C_RESET=$'\033[0m'
else
  C_CYAN='' C_YELLOW='' C_RED='' C_GREEN='' C_GRAY='' C_RESET=''
fi

step()          { printf '%s==> %s%s\n' "$C_CYAN" "$1" "$C_RESET"; }
skip()          { printf '%s    (skip) %s%s\n' "$C_GRAY" "$1" "$C_RESET"; }
dry_run_note()  { printf '%s[DryRun] %s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
die()           { printf '%serror: %s%s\n' "$C_RED" "$1" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: setup-android-sdk.sh [-n|--dry-run] [--sdk-root DIR] [-h|--help]

  -n, --dry-run     Print what would happen; change nothing.
  --sdk-root DIR    SDK install location (defaults to the Android Studio
                    location for this OS: ~/Library/Android/sdk on macOS,
                    ~/Android/Sdk on Linux).
  -h, --help        Show this help.

Does not install a JDK. Requires javac 17+ on PATH.
See android/tools/SDK_SETUP.md.
EOF
}

# javac prints "javac 17.0.9" (or "javac 1.8.0_392" on ancient JDKs).
# Returns the major version on stdout, or nothing if javac is missing/unparseable.
installed_jdk_major() {
  command -v javac >/dev/null 2>&1 || return 0
  local raw ver major rest
  raw="$(javac -version 2>&1 || true)"
  ver="$(printf '%s\n' "$raw" | grep -oE '[0-9]+(\.[0-9]+)*' | head -n1 || true)"
  [[ -n "$ver" ]] || return 0
  major="${ver%%.*}"
  if [[ "$major" == "1" ]]; then
    rest="${ver#1.}"
    major="${rest%%.*}"
  fi
  printf '%s\n' "$major"
}

download_with_verification() {
  local url="$1" outfile="$2"
  step "Downloading $url"
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fL --retry 3 --retry-delay 2 -o "$outfile" "$url"; then
      die "Download failed for $url
If this was a 404, the pinned cmdline-tools revision ($CMDLINE_TOOLS_REVISION) is probably stale --
check https://developer.android.com/studio for the current build number and update this script."
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -O "$outfile" "$url"; then
      die "Download failed for $url
If this was a 404, the pinned cmdline-tools revision ($CMDLINE_TOOLS_REVISION) is probably stale --
check https://developer.android.com/studio for the current build number and update this script."
    fi
  else
    die "Need curl or wget on PATH to download $url"
  fi

  [[ -f "$outfile" ]] || die "Download of $url reported success but $outfile does not exist."
  local size
  size="$(wc -c < "$outfile" | tr -d ' ')"
  if (( size < MIN_ZIP_BYTES )); then
    die "Downloaded file $outfile is only $size bytes (expected at least $MIN_ZIP_BYTES).
That looks like a truncated download or an HTML error page, not the real archive."
  fi
  printf '    downloaded %s MB\n' "$(awk -v s="$size" 'BEGIN { printf "%.1f", s / 1048576 }')"
}

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

DRY_RUN=0
SDK_ROOT_ARG=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --sdk-root)
      [[ $# -ge 2 ]] || die "--sdk-root requires a directory argument"
      SDK_ROOT_ARG="$2"
      shift 2
      ;;
    --sdk-root=*) SDK_ROOT_ARG="${1#--sdk-root=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# OS / zip name / default SDK root
# ---------------------------------------------------------------------------

OS_NAME="$(uname -s)"
OS_ARCH="$(uname -m)"

case "$OS_NAME" in
  Darwin)
    case "$OS_ARCH" in
      arm64)  ZIP_OS='mac_arm64' ;;
      x86_64) ZIP_OS='mac_x86_64' ;;
      *) die "Unsupported macOS architecture: $OS_ARCH" ;;
    esac
    DEFAULT_SDK_ROOT="$HOME/Library/Android/sdk"
    ;;
  Linux)
    ZIP_OS='linux'
    DEFAULT_SDK_ROOT="$HOME/Android/Sdk"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "On Windows use android/tools/setup-android-sdk.ps1 instead of this script."
    ;;
  *)
    die "Unsupported OS: $OS_NAME (this script covers macOS and Linux; Windows uses setup-android-sdk.ps1)."
    ;;
esac

CMDLINE_TOOLS_ZIP_NAME="commandlinetools-${ZIP_OS}-${CMDLINE_TOOLS_REVISION}_latest.zip"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/${CMDLINE_TOOLS_ZIP_NAME}"

if [[ -n "$SDK_ROOT_ARG" ]]; then
  SDK_ROOT="$SDK_ROOT_ARG"
else
  SDK_ROOT="$DEFAULT_SDK_ROOT"
fi

# Resolve to an absolute path so local.properties is not relative to CWD.
# (readlink -f is GNU; macOS has no -f, so fall back to cd/pwd.)
if [[ -d "$SDK_ROOT" ]]; then
  SDK_ROOT="$(cd "$SDK_ROOT" && pwd)"
else
  parent="$(dirname "$SDK_ROOT")"
  base="$(basename "$SDK_ROOT")"
  if [[ -d "$parent" ]]; then
    SDK_ROOT="$(cd "$parent" && pwd)/$base"
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_PROPS_PATH="$ANDROID_DIR/local.properties"

CMDLINE_TOOLS_LATEST="$SDK_ROOT/cmdline-tools/latest"
SDKMANAGER="$CMDLINE_TOOLS_LATEST/bin/sdkmanager"

# ---------------------------------------------------------------------------
# 0. Banner
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%s==================================================%s\n' "$C_YELLOW" "$C_RESET"
  printf '%s DRY RUN -- nothing will be downloaded, installed,%s\n' "$C_YELLOW" "$C_RESET"
  printf '%s or changed. This only prints what would happen.%s\n' "$C_YELLOW" "$C_RESET"
  printf '%s==================================================%s\n' "$C_YELLOW" "$C_RESET"
fi

# ---------------------------------------------------------------------------
# 1. JDK 17+ check -- never silently downloaded (runs even in --dry-run)
# ---------------------------------------------------------------------------

step "Checking for a JDK ${MIN_JDK_MAJOR}+"
JDK_MAJOR="$(installed_jdk_major || true)"
if [[ -z "$JDK_MAJOR" ]] || (( JDK_MAJOR < MIN_JDK_MAJOR )); then
  if [[ -n "$JDK_MAJOR" ]]; then
    found="JDK $JDK_MAJOR"
  else
    found='no JDK at all (javac not found on PATH)'
  fi
  printf '\n'
  printf '%sNo JDK %s+ found -- found: %s.%s\n' "$C_RED" "$MIN_JDK_MAJOR" "$found" "$C_RESET"
  printf '%sThis script will not silently download a JDK for you. Install one, then re-run it:%s\n' "$C_RED" "$C_RESET"
  printf '\n'
  case "$OS_NAME" in
    Darwin)
      printf '    %sbrew install --cask temurin@17%s\n' "$C_GREEN" "$C_RESET"
      printf '\n'
      printf "(If you'd rather match the Microsoft build the Windows script suggests, any JDK 17+\n"
      printf " with javac on PATH is fine -- Temurin is what CI uses at .github/workflows/android-apk.yml.)\n"
      ;;
    *)
      printf '    %ssudo apt-get install -y temurin-17-jdk%s   # Debian/Ubuntu (Eclipse Temurin repo)\n' "$C_GREEN" "$C_RESET"
      printf '    %ssudo dnf install -y java-17-openjdk-devel%s  # Fedora/RHEL\n' "$C_GREEN" "$C_RESET"
      printf '\n'
      printf "(CI at .github/workflows/android-apk.yml uses Eclipse Temurin 17. Any JDK 17+ with\n"
      printf " javac on PATH works identically for this project.)\n"
      ;;
  esac
  printf '\n'
  printf 'Open a NEW terminal after installing (PATH changes need a fresh shell), then re-run:\n'
  printf '    bash "%s"\n' "$SCRIPT_DIR/setup-android-sdk.sh"
  exit 1
fi
printf '    found JDK %s\n' "$JDK_MAJOR"

command -v unzip >/dev/null 2>&1 || die "unzip is required (install it and re-run)."

# ---------------------------------------------------------------------------
# 2. Android command-line tools -- download + lay out at cmdline-tools/latest
# ---------------------------------------------------------------------------

step "Checking for Android command-line tools at $CMDLINE_TOOLS_LATEST"
if [[ -x "$SDKMANAGER" || -f "$SDKMANAGER" ]]; then
  skip "cmdline-tools already laid out at $CMDLINE_TOOLS_LATEST"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  dry_run_note "Would download $CMDLINE_TOOLS_URL and lay it out at $CMDLINE_TOOLS_LATEST"
else
  mkdir -p "$SDK_ROOT"
  zip_path="$SDK_ROOT/$CMDLINE_TOOLS_ZIP_NAME"
  download_with_verification "$CMDLINE_TOOLS_URL" "$zip_path"

  if ! unzip -t "$zip_path" >/dev/null; then
    die "Downloaded archive $zip_path is not a valid zip. Delete it and re-run, or check
https://developer.android.com/studio for a fresh URL/revision."
  fi

  # --- THE DIRECTORY-SHAPE TRAP ---
  # The zip's only top-level entry is a folder literally named "cmdline-tools"
  # (containing bin/, lib/, NOTICE.txt, source.properties). sdkmanager will
  # NOT find itself unless that folder is renamed to "latest" one level under
  # a "cmdline-tools" parent, i.e. the final path must be exactly:
  #     <SdkRoot>/cmdline-tools/latest/bin/sdkmanager
  # Extracting the zip straight into <SdkRoot>/cmdline-tools/ produces
  # <SdkRoot>/cmdline-tools/cmdline-tools/bin/... instead -- wrong, double
  # nested, and sdkmanager silently fails to resolve its own SDK root when
  # laid out that way. So: extract to a scratch directory first, then MOVE
  # the inner "cmdline-tools" folder to ".../cmdline-tools/latest", then
  # delete the scratch directory. This is the single most common
  # cmdline-tools setup mistake, which is why it gets handled explicitly
  # here instead of a bare unzip into the final location.
  extract_tmp="$SDK_ROOT/cmdline-tools/_setup_tmp_extract"
  rm -rf "$extract_tmp"
  mkdir -p "$extract_tmp"

  step "Extracting $CMDLINE_TOOLS_ZIP_NAME"
  unzip -q "$zip_path" -d "$extract_tmp"

  inner_folder="$extract_tmp/cmdline-tools"
  if [[ ! -f "$inner_folder/bin/sdkmanager" ]]; then
    die "Extracted archive doesn't have the expected cmdline-tools/bin/sdkmanager layout.
The zip contents may have changed upstream -- inspect $extract_tmp by hand."
  fi

  mkdir -p "$SDK_ROOT/cmdline-tools"
  rm -rf "$CMDLINE_TOOLS_LATEST"
  mv "$inner_folder" "$CMDLINE_TOOLS_LATEST"
  chmod +x "$CMDLINE_TOOLS_LATEST/bin/"* 2>/dev/null || true

  rm -rf "$extract_tmp"
  rm -f "$zip_path"

  [[ -f "$SDKMANAGER" ]] || die "Layout finished but $SDKMANAGER still doesn't exist -- something went wrong moving the extracted folder."
  printf '    cmdline-tools laid out at %s\n' "$CMDLINE_TOOLS_LATEST"
fi

# ---------------------------------------------------------------------------
# 3. Accept licences non-interactively, then install packages
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  dry_run_note "Would run: sdkmanager --licenses (auto-answering 'y' to every prompt)"
  dry_run_note "Would run: sdkmanager ${PLATFORM_PACKAGES[*]}"
else
  [[ -f "$SDKMANAGER" ]] || die "sdkmanager not found at $SDKMANAGER -- cmdline-tools setup must have failed above."
  chmod +x "$SDKMANAGER" 2>/dev/null || true
  sdk_root_arg="--sdk_root=$SDK_ROOT"

  step "Accepting SDK licences non-interactively"
  # sdkmanager --licenses is interactive by design (a y/N prompt per
  # licence). Feed it a long stream of "y" answers as separate lines so it
  # reads them one per prompt, however many licences this revision happens
  # to show -- it must never block waiting on stdin. 100 answers matches
  # the Windows script; `yes` is avoided because pipefail + SIGPIPE is messy.
  yes_answers="$(printf 'y\n%.0s' {1..100})"
  if ! printf '%s' "$yes_answers" | "$SDKMANAGER" "$sdk_root_arg" --licenses; then
    die "sdkmanager --licenses exited with a non-zero status"
  fi

  step "Installing: ${PLATFORM_PACKAGES[*]}"
  if ! "$SDKMANAGER" "$sdk_root_arg" "${PLATFORM_PACKAGES[@]}"; then
    die "sdkmanager package install exited with a non-zero status"
  fi

  # Verify on disk rather than trusting the exit code alone.
  # (Plain list, not an associative array — macOS still ships bash 3.2.)
  _verify_pkg() {
    local rel="$1" pkg="$2" full="$SDK_ROOT/$rel"
    if [[ ! -e "$full" ]]; then
      die "Expected $full to exist after installing $pkg, but it's missing.
sdkmanager reported success but the package doesn't look installed."
    fi
  }
  _verify_pkg 'platform-tools/adb' 'platform-tools'
  _verify_pkg 'platforms/android-34/android.jar' 'platforms;android-34'
  _verify_pkg 'build-tools/34.0.0/aapt' 'build-tools;34.0.0'
  printf '    all packages verified on disk\n'
fi

# ---------------------------------------------------------------------------
# 4. ANDROID_HOME / ANDROID_SDK_ROOT -- print lines, do not edit rc files
# ---------------------------------------------------------------------------

step "ANDROID_HOME / ANDROID_SDK_ROOT"
ENV_LINES=$(cat <<EOF
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="\$ANDROID_HOME/platform-tools:\$PATH"
EOF
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  dry_run_note "Would print the following env lines (this script never silently edits bashrc/zshrc):"
  printf '%s\n' "$ENV_LINES"
else
  # If this file was sourced, export into the current shell. If it was
  # executed, those exports die with this process -- hence the printed
  # lines either way.
  export ANDROID_HOME="$SDK_ROOT"
  export ANDROID_SDK_ROOT="$SDK_ROOT"
  case ":$PATH:" in
    *":$SDK_ROOT/platform-tools:"*) ;;
    *) export PATH="$SDK_ROOT/platform-tools:$PATH" ;;
  esac
  printf '    ANDROID_HOME = %s\n' "$SDK_ROOT"
  printf '    ANDROID_SDK_ROOT = %s\n' "$SDK_ROOT"
  printf '\n'
  printf '    This script does not silently edit ~/.bashrc or ~/.zshrc.\n'
  printf '    For the current shell, run:\n\n'
  printf '%s\n' "$ENV_LINES" | sed 's/^/        /'
  printf '\n'
  printf '    To persist across new shells, add those exact three lines to ~/.bashrc\n'
  printf '    (bash) or ~/.zshrc (zsh), then open a new terminal.\n'
fi

# ---------------------------------------------------------------------------
# 5. Write android/local.properties
# ---------------------------------------------------------------------------

step "Writing android/local.properties"

# Gradle's properties parser treats "\" as an escape character. Unix paths
# already use forward slashes; normalize anyway so a --sdk-root with mixed
# separators still works.
sdk_dir_forward="${SDK_ROOT//\\//}"
local_props_content="## Auto-generated by tools/setup-android-sdk.sh -- re-run the script to refresh this, don't hand-edit sdk.dir.
sdk.dir=${sdk_dir_forward}
"

# Command substitution strips trailing newlines; append a sentinel so a
# byte-identical file still compares equal to $local_props_content.
_existing=''
if [[ -f "$LOCAL_PROPS_PATH" ]]; then
  _existing="$(cat "$LOCAL_PROPS_PATH"; printf x)"
  _existing="${_existing%x}"
fi
if [[ -n "$_existing" && "$_existing" == "$local_props_content" ]]; then
  skip "$LOCAL_PROPS_PATH already up to date"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  dry_run_note "Would write $LOCAL_PROPS_PATH with sdk.dir=$sdk_dir_forward"
else
  printf '%s' "$local_props_content" > "$LOCAL_PROPS_PATH"
  printf '    wrote %s\n' "$LOCAL_PROPS_PATH"
fi

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------

printf '\n'
step "Done."
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'This was a dry run -- nothing was downloaded, installed, or changed.\n'
else
  printf 'SDK ready at: %s\n' "$SDK_ROOT"
  printf '\n'
  printf 'This script does not install Gradle itself. From a NEW terminal (so the PATH/env\n'
  printf 'exports above take effect), the remaining one-time step is:\n'
  printf '  cd android\n'
  printf '  gradle wrapper        # generates gradlew + gradle-wrapper.jar (needs `gradle` on PATH)\n'
  printf '  ./gradlew assembleDebug\n'
  printf '\n'
  printf 'See android/tools/SDK_SETUP.md for details and the CI alternative.\n'
fi
exit 0
