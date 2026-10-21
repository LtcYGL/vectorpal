' VectorPal 启动器：无窗口跑守护进程，守护进程再负责拉起 pod。
' 用脚本所在目录（找不到 node.exe 就用 PATH 里的 node），整个文件夹可以随便搬。
Option Explicit
Dim fso, sh, dir, node
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If fso.FileExists(dir & "\node.exe") Then
  node = """" & dir & "\node.exe"""
Else
  node = "node"
End If
sh.CurrentDirectory = dir
sh.Run node & " """ & dir & "\keepalive.mjs""", 0, False
