# Dual launcher: bridge API (node index.js) + WebUI (webui/).
# Windows counterpart of start.sh. Ctrl+C stops both processes.
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root

$bridgePort = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } else { '3141' }
$webuiOrigin = if ($env:WEBUI_ORIGIN) { $env:WEBUI_ORIGIN } else { 'http://127.0.0.1:3000' }
$webuiDir = Join-Path $Root 'webui'
$webuiScript = if (Test-Path (Join-Path $webuiDir '.next')) { 'start' } else { 'dev' }

function Stop-Tree($proc) {
    if ($null -eq $proc) { return }
    $procId = $proc.Id
    cmd.exe /c "taskkill /T /F /PID $procId" 2>$null | Out-Null
}

$bridge = $null
$webui = $null

try {
    Write-Host "Starting Agent OS — two processes (bridge + WebUI)"

    $bridge = Start-Process -FilePath 'node' -ArgumentList 'index.js' -WorkingDirectory $Root -PassThru -NoNewWindow

    $npm = 'npm'
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { $npm = 'npm.cmd' }
    if ($webuiScript -eq 'start') {
        Write-Host "WebUI: npm run start (webui/.next found)"
    } else {
        Write-Host "WebUI: npm run dev (no webui/.next — production build not present)"
    }
    $webui = Start-Process -FilePath $npm -ArgumentList @('run', $webuiScript) -WorkingDirectory $webuiDir -PassThru -NoNewWindow

    Write-Host ""
    Write-Host "  WebUI (Mission Control): $webuiOrigin"
    Write-Host "  Bridge API:              http://127.0.0.1:$bridgePort"
    Write-Host "  Legacy HUD:              http://127.0.0.1:$bridgePort/legacy"
    Write-Host ""
    Write-Host "Two processes, one UI. Ctrl+C stops both."

    while ($true) {
        Start-Sleep -Milliseconds 400
        if ($bridge.HasExited -or $webui.HasExited) { break }
    }
} finally {
    Stop-Tree $bridge
    Stop-Tree $webui
}
