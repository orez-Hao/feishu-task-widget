# 结束正在运行的飞书任务便签窗口（按窗口标题反查进程），供 7-强制重启.cmd 调用
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class WKill {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  public static int Find(string title) {
    int found = 0;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      if (sb.ToString() == title) { int pid; GetWindowThreadProcessId(h, out pid); found = pid; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@ -Language CSharp
$target = [WKill]::Find('飞书任务便签')
if ($target -gt 0) {
  Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
  Write-Host ('已结束旧窗口，PID ' + $target)
} else {
  Write-Host '没有找到正在运行的窗口'
}
