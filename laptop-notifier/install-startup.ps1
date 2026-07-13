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

# Two triggers so the notifier is up in every circumstance:
#   1) at every logon (covers reboot / sign-in)
#   2) every 5 minutes forever (self-heal: if it ever died — crash, kill, or the
#      supervisor itself was force-stopped — it comes back within 5 min). The
#      single-instance lock in index.js makes these relaunches safe (a second
#      copy just exits), so this never stacks instances.
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date)
$rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
$triggerRepeat.Repetition = $rep

# Keep it running with no time limit, start on battery / when available, and
# ignore a new start if one is already launching.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName "LaptopNotifier" `
  -Description "WhatsApp bot laptop notifier (toasts + desk presence)" `
  -Action $action `
  -Trigger $triggerLogon, $triggerRepeat `
  -Settings $settings `
  -RunLevel Limited `
  -Force | Out-Null

Write-Host "Installed scheduled task 'LaptopNotifier': starts hidden at logon and self-heals every 5 min."
Write-Host "Start it now without logging out:  Start-ScheduledTask -TaskName 'LaptopNotifier'"
