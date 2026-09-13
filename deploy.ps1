# =============================================================================
# telegram-bridge-v4 Deployment Script
# 
# This script configures the bridge to run automatically in the background
# every time you log in, with Elevated (Administrator) access.
#
# INSTRUCTIONS:
# Right-click this file and select "Run with PowerShell" when you are ready
# to deploy. You may be prompted by User Account Control (UAC) to grant Admin rights.
# =============================================================================

# Ensure the script is running as Administrator (required to create elevated tasks)
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Requesting Administrator privileges..."
    Start-Process PowerShell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    Exit
}

$TaskName = "TelegramBridgeV4"
$BridgeDir = "C:\Ai\telegram-bridge-v4"
$ScriptPath = "$BridgeDir\index.js"

# 1. Define what to run (wscript running our hidden VBS file)
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$BridgeDir\start_hidden.vbs`"" -WorkingDirectory $BridgeDir

# 2. Triggers: Start on boot, and also run every 15 minutes as a self-healing check
$TriggerStartup = New-ScheduledTaskTrigger -AtStartup
$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
$Triggers = @($TriggerStartup, $TriggerRepeat)

# 3. CRITICAL: Run as current user, whether logged in or not, with HIGHEST PRIVILEGES (S4U)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

# 4. Settings: Keep running indefinitely, allow on battery, and auto-restart on task failure
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Register the task
try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Host ""
    Write-Host "✅ DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
    Write-Host "The Telegram Bridge has been configured to run on startup with Administrator privileges." -ForegroundColor Cyan
    Write-Host "To view or remove this in the future, open 'Task Scheduler' and look for '$TaskName'." -ForegroundColor Gray
    
    # Optionally start it right now so we don't have to reboot
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "The bridge is starting in the background now..." -ForegroundColor Yellow
} catch {
    Write-Host "❌ Failed to configure deployment: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Press any key to exit..."
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
