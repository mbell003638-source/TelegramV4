<#
.SYNOPSIS
    Sets up everything needed to build the android/ Gradle project locally on
    Windows: a check for a JDK 17+, the Android command-line tools, the
    platform-tools/platforms/build-tools packages this project needs, the
    ANDROID_HOME/ANDROID_SDK_ROOT user environment variables, platform-tools
    on PATH, and android/local.properties.

.DESCRIPTION
    Idempotent: safe to re-run. Every step first checks whether its result is
    already in place and skips the work if so. Nothing is downloaded or
    installed silently -- a missing JDK stops the script with the exact
    command to install one, and every download/install step verifies its own
    result and throws (loudly) instead of continuing on a partial failure.

    This script does NOT install a JDK and does NOT install Gradle itself.
    See android/tools/SDK_SETUP.md for the full picture, including the
    lower-effort alternative of letting .github/workflows/android-apk.yml
    build the APK in CI instead of doing any of this locally.

.PARAMETER DryRun
    Print what the script would do and change nothing: no downloads, no
    installs, no environment variables, no files written.

.PARAMETER SdkRoot
    Where to install the SDK. Defaults to the same location Android Studio
    itself defaults to on Windows: $env:LOCALAPPDATA\Android\Sdk.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File android\tools\setup-android-sdk.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File android\tools\setup-android-sdk.ps1
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar is painfully slow otherwise.

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
$CmdlineToolsRevision = '15859902'
$CmdlineToolsZipName  = "commandlinetools-win-${CmdlineToolsRevision}_latest.zip"
$CmdlineToolsUrl      = "https://dl.google.com/android/repository/${CmdlineToolsZipName}"

# Matches android/app/build.gradle.kts: compileSdk = 34, targetSdk = 34.
$PlatformPackages = @('platform-tools', 'platforms;android-34', 'build-tools;34.0.0')

$MinJdkMajor = 17
$MinZipBytes = 50MB   # real download is ~155 MB; anything far smaller is a truncated/failed download or an HTML error page.

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Skip { param([string]$Message) Write-Host "    (skip) $Message" -ForegroundColor DarkGray }
function Write-DryRunNote { param([string]$Message) Write-Host "[DryRun] $Message" -ForegroundColor Yellow }

function Get-InstalledJdkMajorVersion {
    # Checks for `javac` specifically (not just `java`) because we need a JDK,
    # not merely a JRE, to build with Gradle.
    $javac = Get-Command javac -ErrorAction SilentlyContinue
    if (-not $javac) { return $null }

    try {
        # javac prints its version to STDOUT as e.g. "javac 17.0.9" (unlike
        # `java -version`, which prints to STDERR) -- 2>&1 covers both cases.
        $raw = (& javac -version) 2>&1 | Out-String
    } catch {
        Write-Verbose "javac -version failed to run: $($_.Exception.Message)"
        return $null
    }

    if ($raw -notmatch '(\d+)(?:\.\d+)*') { return $null }
    $major = [int]$Matches[1]

    # Old versioning scheme: "1.8.0_392" means Java 8, not Java 1.
    if ($major -eq 1 -and $raw -match '1\.(\d+)') {
        return [int]$Matches[1]
    }
    return $major
}

function Get-FileWithVerification {
    param(
        [Parameter(Mandatory)] [string]$Url,
        [Parameter(Mandatory)] [string]$OutFile
    )
    Write-Step "Downloading $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    } catch {
        throw "Download failed for $Url : $($_.Exception.Message)`n" +
              "If this was a 404, the pinned cmdline-tools revision ($CmdlineToolsRevision) is probably stale -- " +
              "check https://developer.android.com/studio for the current build number and update this script."
    }

    if (-not (Test-Path $OutFile)) {
        throw "Download of $Url reported success but $OutFile does not exist."
    }
    $size = (Get-Item $OutFile).Length
    if ($size -lt $MinZipBytes) {
        throw "Downloaded file $OutFile is only $size bytes (expected at least $MinZipBytes). " +
              "That looks like a truncated download or an HTML error page, not the real archive."
    }
    Write-Host "    downloaded $([Math]::Round($size / 1MB, 1)) MB"
}

function Test-ZipIsValid {
    param([Parameter(Mandatory)] [string]$Path)
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
        $zip.Dispose()
        return $true
    } catch {
        Write-Warning "Zip validation failed for $Path : $($_.Exception.Message)"
        return $false
    }
}

# ---------------------------------------------------------------------------
# 0. Banner
# ---------------------------------------------------------------------------

if ($DryRun) {
    Write-Host "==================================================" -ForegroundColor Yellow
    Write-Host " DRY RUN -- nothing will be downloaded, installed," -ForegroundColor Yellow
    Write-Host " or changed. This only prints what would happen." -ForegroundColor Yellow
    Write-Host "==================================================" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 1. JDK 17+ check -- never silently downloaded
# ---------------------------------------------------------------------------

Write-Step "Checking for a JDK $MinJdkMajor+"
$jdkMajor = Get-InstalledJdkMajorVersion
if (-not $jdkMajor -or $jdkMajor -lt $MinJdkMajor) {
    $found = if ($jdkMajor) { "JDK $jdkMajor" } else { 'no JDK at all (javac not found on PATH)' }
    Write-Host ""
    Write-Host "No JDK $MinJdkMajor+ found -- found: $found." -ForegroundColor Red
    Write-Host "This script will not silently download a JDK for you. Install one, then re-run it:" -ForegroundColor Red
    Write-Host ""
    Write-Host "    winget install --id Microsoft.OpenJDK.17 -e --source winget" -ForegroundColor Green
    Write-Host ""
    Write-Host "(If winget can't find that exact id, run 'winget search Microsoft.OpenJDK' to see what's"
    Write-Host " currently published. The CI workflow at .github/workflows/android-apk.yml uses Eclipse"
    Write-Host " Temurin 17 instead of Microsoft's build -- 'winget install --id EclipseAdoptium.Temurin.17.JDK -e'"
    Write-Host " works identically for this project if you'd rather match CI exactly.)"
    Write-Host ""
    Write-Host "Open a NEW terminal after installing (PATH changes need a fresh shell), then re-run:"
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 1
}
Write-Host "    found JDK $jdkMajor"

# ---------------------------------------------------------------------------
# 2. Android command-line tools -- download + lay out at cmdline-tools/latest
# ---------------------------------------------------------------------------

$cmdlineToolsLatest = Join-Path $SdkRoot 'cmdline-tools\latest'
$sdkManagerBat      = Join-Path $cmdlineToolsLatest 'bin\sdkmanager.bat'

Write-Step "Checking for Android command-line tools at $cmdlineToolsLatest"
if (Test-Path $sdkManagerBat) {
    Write-Skip "cmdline-tools already laid out at $cmdlineToolsLatest"
} elseif ($DryRun) {
    Write-DryRunNote "Would download $CmdlineToolsUrl and lay it out at $cmdlineToolsLatest"
} else {
    New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null

    $zipPath = Join-Path $SdkRoot $CmdlineToolsZipName
    Get-FileWithVerification -Url $CmdlineToolsUrl -OutFile $zipPath

    if (-not (Test-ZipIsValid -Path $zipPath)) {
        throw "Downloaded archive $zipPath is not a valid zip. Delete it and re-run, or check " +
              "https://developer.android.com/studio for a fresh URL/revision."
    }

    # --- THE DIRECTORY-SHAPE TRAP ---
    # The zip's only top-level entry is a folder literally named "cmdline-tools"
    # (containing bin/, lib/, NOTICE.txt, source.properties). sdkmanager will
    # NOT find itself unless that folder is renamed to "latest" one level under
    # a "cmdline-tools" parent, i.e. the final path must be exactly:
    #     <SdkRoot>\cmdline-tools\latest\bin\sdkmanager.bat
    # Extracting the zip straight into <SdkRoot>\cmdline-tools\ produces
    # <SdkRoot>\cmdline-tools\cmdline-tools\bin\... instead -- wrong, double
    # nested, and sdkmanager silently fails to resolve its own SDK root when
    # laid out that way. So: extract to a scratch directory first, then MOVE
    # the inner "cmdline-tools" folder to "...\cmdline-tools\latest", then
    # delete the scratch directory. This is the single most common
    # cmdline-tools setup mistake, which is why it gets handled explicitly
    # here instead of a bare Expand-Archive into the final location.
    $extractTmp = Join-Path $SdkRoot 'cmdline-tools\_setup_tmp_extract'
    if (Test-Path $extractTmp) { Remove-Item $extractTmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extractTmp | Out-Null

    Write-Step "Extracting $CmdlineToolsZipName"
    Expand-Archive -Path $zipPath -DestinationPath $extractTmp -Force

    $innerFolder = Join-Path $extractTmp 'cmdline-tools'
    if (-not (Test-Path (Join-Path $innerFolder 'bin\sdkmanager.bat'))) {
        throw "Extracted archive doesn't have the expected cmdline-tools\bin\sdkmanager.bat layout. " +
              "The zip contents may have changed upstream -- inspect $extractTmp by hand."
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $SdkRoot 'cmdline-tools') | Out-Null
    if (Test-Path $cmdlineToolsLatest) { Remove-Item $cmdlineToolsLatest -Recurse -Force }
    Move-Item -Path $innerFolder -Destination $cmdlineToolsLatest

    Remove-Item $extractTmp -Recurse -Force
    Remove-Item $zipPath -Force

    if (-not (Test-Path $sdkManagerBat)) {
        throw "Layout finished but $sdkManagerBat still doesn't exist -- something went wrong moving the extracted folder."
    }
    Write-Host "    cmdline-tools laid out at $cmdlineToolsLatest"
}

# ---------------------------------------------------------------------------
# 3. Accept licences non-interactively, then install packages
# ---------------------------------------------------------------------------

if ($DryRun) {
    Write-DryRunNote "Would run: sdkmanager --licenses (auto-answering 'y' to every prompt)"
    Write-DryRunNote "Would run: sdkmanager $($PlatformPackages -join ' ')"
} else {
    if (-not (Test-Path $sdkManagerBat)) {
        throw "sdkmanager not found at $sdkManagerBat -- cmdline-tools setup must have failed above."
    }
    $sdkRootArg = "--sdk_root=$SdkRoot"

    Write-Step "Accepting SDK licences non-interactively"
    # sdkmanager --licenses is interactive by design (a y/N prompt per
    # licence). Feed it a long stream of "y" answers as separate pipeline
    # objects (not one giant string) so it reads them one per prompt, however
    # many licences this revision happens to show -- it must never block
    # waiting on stdin.
    $yesAnswers = 1..100 | ForEach-Object { 'y' }
    $yesAnswers | & $sdkManagerBat $sdkRootArg --licenses 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "sdkmanager --licenses exited with code $LASTEXITCODE"
    }

    Write-Step "Installing: $($PlatformPackages -join ', ')"
    & $sdkManagerBat $sdkRootArg @PlatformPackages 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "sdkmanager package install exited with code $LASTEXITCODE"
    }

    # Verify on disk rather than trusting the exit code alone.
    $expectedPaths = @{
        'platform-tools\adb.exe'           = 'platform-tools'
        'platforms\android-34\android.jar' = 'platforms;android-34'
        'build-tools\34.0.0\aapt.exe'      = 'build-tools;34.0.0'
    }
    foreach ($rel in $expectedPaths.Keys) {
        $full = Join-Path $SdkRoot $rel
        if (-not (Test-Path $full)) {
            throw "Expected $full to exist after installing $($expectedPaths[$rel]), but it's missing. " +
                  "sdkmanager reported success but the package doesn't look installed."
        }
    }
    Write-Host "    all packages verified on disk"
}

# ---------------------------------------------------------------------------
# 4. Persist ANDROID_HOME / ANDROID_SDK_ROOT (User scope)
# ---------------------------------------------------------------------------

Write-Step "Persisting ANDROID_HOME / ANDROID_SDK_ROOT (User environment)"
if ($DryRun) {
    Write-DryRunNote "Would set User env ANDROID_HOME=$SdkRoot and ANDROID_SDK_ROOT=$SdkRoot"
} else {
    [Environment]::SetEnvironmentVariable('ANDROID_HOME', $SdkRoot, 'User')
    [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $SdkRoot, 'User')
    $env:ANDROID_HOME = $SdkRoot
    $env:ANDROID_SDK_ROOT = $SdkRoot
    Write-Host "    ANDROID_HOME = $SdkRoot"
    Write-Host "    ANDROID_SDK_ROOT = $SdkRoot"
}

# ---------------------------------------------------------------------------
# 5. Add platform-tools to the User PATH, without duplicating
# ---------------------------------------------------------------------------

Write-Step "Adding platform-tools to the User PATH"
$platformToolsPath = Join-Path $SdkRoot 'platform-tools'
$currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = @()
if ($currentUserPath) { $pathEntries = $currentUserPath -split ';' | Where-Object { $_ -ne '' } }
$alreadyOnPath = $pathEntries | Where-Object { $_.TrimEnd('\') -ieq $platformToolsPath.TrimEnd('\') }

if ($alreadyOnPath) {
    Write-Skip "platform-tools already on the User PATH"
} elseif ($DryRun) {
    Write-DryRunNote "Would append $platformToolsPath to the User PATH"
} else {
    $newPath = if ($currentUserPath) { "$currentUserPath;$platformToolsPath" } else { $platformToolsPath }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$platformToolsPath"
    Write-Host "    appended $platformToolsPath"
}

# ---------------------------------------------------------------------------
# 6. Write android/local.properties
# ---------------------------------------------------------------------------

Write-Step "Writing android/local.properties"
$androidDir = Split-Path -Parent $PSScriptRoot   # PSScriptRoot = android/tools
$localPropsPath = Join-Path $androidDir 'local.properties'

# Gradle's properties parser treats "\" as an escape character, so a literal
# Windows path like C:\Users\...\Sdk must be written with forward slashes
# (C:/Users/.../Sdk) or doubled backslashes -- a bare single-backslash path
# here is a classic way to make Gradle fail to find the SDK. Forward slashes
# work fine on Windows and are simpler, so that's what gets written.
$sdkDirForward = $SdkRoot -replace '\\', '/'
$localPropsContent = "## Auto-generated by tools/setup-android-sdk.ps1 -- re-run the script to refresh this, don't hand-edit sdk.dir.`nsdk.dir=$sdkDirForward`n"

$existingContent = if (Test-Path $localPropsPath) { Get-Content -Path $localPropsPath -Raw } else { $null }
if ($existingContent -eq $localPropsContent) {
    Write-Skip "$localPropsPath already up to date"
} elseif ($DryRun) {
    Write-DryRunNote "Would write $localPropsPath with sdk.dir=$sdkDirForward"
} else {
    Set-Content -Path $localPropsPath -Value $localPropsContent -NoNewline -Encoding UTF8
    Write-Host "    wrote $localPropsPath"
}

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "==> Done." -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "This was a dry run -- nothing was downloaded, installed, or changed."
} else {
    Write-Host "SDK ready at: $SdkRoot"
    Write-Host ""
    Write-Host "This script does not install Gradle itself. From a NEW terminal (so the PATH/env"
    Write-Host "changes above take effect), the remaining one-time step is:"
    Write-Host "  cd android"
    Write-Host "  gradle wrapper        # generates gradlew.bat + gradle-wrapper.jar (needs `gradle` on PATH)"
    Write-Host "  .\gradlew.bat assembleDebug"
    Write-Host ""
    Write-Host "See android\tools\SDK_SETUP.md for details and the CI alternative."
}
exit 0
