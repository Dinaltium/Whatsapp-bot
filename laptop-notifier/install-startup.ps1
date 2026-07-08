# Registers the laptop notifier to run hidden at every logon, and to relaunch
# if it ever stops. Run once, from an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File install-startup.ps1
#
# Uninstall:  Unregister-ScheduledTask -TaskName "LaptopNotifier" -Confirm:$false

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$vbs = Join-Path $dir "start-hidden.vbs"

if (-not (Test-Path $vbs)) { throw "start-hidden.vbs not found next to this script." }

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"{0}"' -f $vbs)
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Restart the task if it ever fails, keep it running with no time limit, and
# start it even on battery / when it becomes available.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName "LaptopNotifier" `
  -Description "WhatsApp bot laptop notifier (toasts + desk presence)" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Limited `
  -Force | Out-Null

Write-Host "Installed scheduled task 'LaptopNotifier'. It will start hidden at every logon."
Write-Host "Start it now without logging out:  Start-ScheduledTask -TaskName 'LaptopNotifier'"
