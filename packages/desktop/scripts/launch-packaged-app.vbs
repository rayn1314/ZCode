' ============================================================================
' Fork self-built app one-click launcher (repo-level; works for any clone).
'
' Why a launcher instead of shortcut-ing the exe directly:
' The self-built app needs ZCODE_REMOTE_ASSET_LOCAL_DIR pointing at this
' repo's packages/desktop/mock-cdn when it deploys the server to WSL/SSH.
' Without it the app falls back to the official CDN, whose bundles do not
' recognize fork-only protocol fields, so the first remote sync fails.
'
' Usage:
'   - double-click this file, or
'   - point a shortcut at:  wscript //nologo <repo>\packages\desktop\scripts\launch-packaged-app.vbs
'   - or from the repo root:  pnpm --filter @zcode/desktop launch
'
' Note: ASCII-only on purpose. VBScript reads files as ANSI; UTF-8 Chinese
' would render as mojibake in the popup on non-matching-codepage Windows.
' ============================================================================
Option Explicit

Dim fso, shell, scriptDir, repoRoot, distDir, exePath

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' scripts -> desktop -> packages -> repo root
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(scriptDir)))
distDir = fso.BuildPath(repoRoot, "packages\desktop\dist\win-unpacked")

exePath = FindProductExe(fso, distDir)
If exePath = "" Then
  shell.Popup "Build output not found:" & vbCrLf & distDir & vbCrLf & vbCrLf & _
    "Run ""pnpm package:desktop"" at the repo root first.", 15, "ZCode Rayn", 48
  WScript.Quit 1
End If

' Remote (WSL/SSH) deployment source: locally built assets from this repo.
shell.Environment("PROCESS")("ZCODE_REMOTE_ASSET_LOCAL_DIR") = _
  fso.BuildPath(repoRoot, "packages\desktop\mock-cdn")
shell.CurrentDirectory = fso.GetParentFolderName(exePath)
shell.Run """" & exePath & """", 1, False

Function FindProductExe(fso, dir)
  Dim folder, file
  FindProductExe = ""
  If Not fso.FolderExists(dir) Then Exit Function
  Set folder = fso.GetFolder(dir)
  ' win-unpacked top level holds exactly one product exe (helpers live under resources\)
  For Each file In folder.Files
    If LCase(fso.GetExtensionName(file.Name)) = "exe" Then
      FindProductExe = file.Path
      Exit Function
    End If
  Next
End Function
