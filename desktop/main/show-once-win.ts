import { win32 } from "node:path";

/**
 * ATO-2499 "Show once" on Windows: one resident Windows PowerShell 5.1
 * process that answers what was under each click and behind each key,
 * speaking the Accessibility helper's line protocol
 * (native/atomic-show-once.swift header; show-once-helper.ts is its client):
 *
 *   stdin   click <id> <x> <y>   |   key <id>
 *   stdout  {"ready":true} once, then one answer per question:
 *           {id, app:{name,bundleId,pid}, window:{x,y,width,height}, windowTitle, element, focused}
 *
 * The app is the process that owns the top-level window (user32
 * WindowFromPoint / GetForegroundWindow, GetWindowThreadProcessId); its
 * bundleId is the executable name, lowercased (`notepad.exe`), which
 * show-once-classify.ts matches against its Windows lists. The control is
 * read with UI Automation (AutomationElement.FromPoint / FocusedElement):
 * only its ControlType, Name and IsPassword. A Name is the control's label,
 * never what is typed in it (no ValuePattern is read). ControlTypes map to
 * the Accessibility role words the rest of Show once uses, so a password box
 * is AXSecureTextField and nothing of it is kept.
 *
 * Read-only: nothing is clicked, typed or captured. Every read is wrapped,
 * so a control that refuses UI Automation answers with the app and the
 * window only. No push events: Windows has no menu-command observer here.
 * No electron import.
 */

export const SHOW_ONCE_WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class AtomicShowOnce {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
"@
[void][AtomicShowOnce]::SetProcessDPIAware()
$roles = @{ 'Button'='AXButton'; 'SplitButton'='AXMenuButton'; 'MenuItem'='AXMenuItem'; 'CheckBox'='AXCheckBox';
  'RadioButton'='AXRadioButton'; 'TabItem'='AXTab'; 'Edit'='AXTextField'; 'Document'='AXTextArea'; 'ComboBox'='AXComboBox';
  'Hyperlink'='AXLink'; 'ListItem'='AXRow'; 'TreeItem'='AXRow'; 'DataItem'='AXCell'; 'Slider'='AXSlider'; 'Spinner'='AXIncrementor';
  'Text'='AXStaticText'; 'Image'='AXImage' }
function Describe($el, $withLabel) {
  if ($null -eq $el) { return $null }
  try {
    $c = $el.Current
    $t = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    $role = $roles[$t]; if (-not $role) { $role = 'AXGroup' }
    if ($c.IsPassword) { return @{ role = 'AXSecureTextField'; label = '' } }
    $label = ''; if ($withLabel) { $label = [string]$c.Name; if ($label.Length -gt 120) { $label = $label.Substring(0, 120) } }
    return @{ role = $role; label = $label }
  } catch { return $null }
}
function AppOf($h) {
  $procId = [uint32]0
  [void][AtomicShowOnce]::GetWindowThreadProcessId($h, [ref]$procId)
  if ($procId -eq 0) { return $null }
  $p = Get-Process -Id $procId
  if ($null -eq $p) { return $null }
  $name = [string]$p.ProcessName
  try { $d = [string]$p.MainModule.FileVersionInfo.FileDescription; if ($d) { $name = $d } } catch {}
  return @{ name = $name; bundleId = ([string]$p.ProcessName).ToLower() + '.exe'; pid = [int]$procId }
}
function WindowOf($h) {
  $r = New-Object AtomicShowOnce+RC
  if (-not [AtomicShowOnce]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T }
}
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $a = $line.Trim() -split '\s+'
  $id = 0; if (-not [int]::TryParse($a[1], [ref]$id)) { continue }
  $out = @{ id = $id; app = $null; window = $null; windowTitle = $null; element = $null; focused = $null }
  try {
    if ($a[0] -eq 'click' -and $a.Length -ge 4) {
      $pt = New-Object AtomicShowOnce+PT; $pt.X = [int]$a[2]; $pt.Y = [int]$a[3]
      $h = [AtomicShowOnce]::GetAncestor([AtomicShowOnce]::WindowFromPoint($pt), 2)
      if ($h -eq [IntPtr]::Zero) { $h = [AtomicShowOnce]::GetForegroundWindow() }
      try { $out.element = Describe ([System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($pt.X, $pt.Y)))) $true } catch {}
    } else {
      $h = [AtomicShowOnce]::GetForegroundWindow()
      try { $out.focused = Describe ([System.Windows.Automation.AutomationElement]::FocusedElement) $true } catch {}
    }
    if ($h -ne [IntPtr]::Zero) {
      $out.app = AppOf $h; $out.window = WindowOf $h
      $t = [AtomicShowOnce]::Title($h); if ($t) { $out.windowTitle = $t }
    }
  } catch {}
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4)); [Console]::Out.Flush()
}
`;

/** Windows PowerShell 5.1, which has UI Automation (PowerShell 7 on .NET does not). */
export function showOnceWinShell(env: Record<string, string | undefined>): string {
  return win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The script goes as -EncodedCommand (UTF-16LE, base64), so stdin stays the line protocol. */
export function showOnceWinArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(SHOW_ONCE_WIN_SCRIPT, "utf16le").toString("base64")];
}
