' Launches run-forever.bat with NO visible window (0 = hidden, False = don't
' wait). This is what the scheduled task runs at logon, so the notifier runs
' completely silently in the background.
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & dir & "\run-forever.bat""", 0, False
