' IMARA LINKS - Silent Launcher
' Run the application without showing console window

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Get the directory where this script is located
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Run the batch file hidden (0 = hidden window)
objShell.Run "cmd /c """ & scriptDir & "\START.bat""", 0, False
