import { desktopChildEnv } from "../tools/os/screen/screen-capture-win-linux.js";
import type { ScreenDeps } from "../tools/os/screen/screen-host.js";
import type { FrontWindowResult } from "./logbook-front-window.js";

/**
 * The window in front on Windows (ATO-2526), one constant PowerShell
 * program: `GetForegroundWindow`, its title (`GetWindowText`), its
 * process (`GetWindowThreadProcessId`, then the process name and file
 * description), and how long since the last key or mouse input
 * (`GetLastInputInfo`). Sent as `-EncodedCommand` with an allow-listed
 * environment, like the screen tools' Windows capture, so nothing is
 * quoted and no key reaches the child. An elevated window hides its
 * file description; the process name is still read.
 */
export const WINDOWS_FRONT_WINDOW_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public static class AtomicFront {",
  "  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);",
  "  public static long IdleMs() {",
  "    LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);",
  "    if (!GetLastInputInfo(ref i)) return -1;",
  "    return (long)unchecked((uint)Environment.TickCount - i.dwTime);",
  "  }",
  "}",
  "'@",
  "$h = [AtomicFront]::GetForegroundWindow()",
  "$sb = New-Object System.Text.StringBuilder 512",
  "[void][AtomicFront]::GetWindowText($h, $sb, 512)",
  "$procId = [uint32]0",
  "[void][AtomicFront]::GetWindowThreadProcessId($h, [ref]$procId)",
  "$name = ''",
  "$desc = ''",
  "if ($procId -ne 0) {",
  "  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue",
  "  if ($p) { $name = $p.ProcessName; try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch { $desc = '' } }",
  "}",
  "@{ title = $sb.ToString(); process = $name; description = $desc; idleMs = [AtomicFront]::IdleMs() } | ConvertTo-Json -Compress",
].join("\n");

export function windowsFrontWindowInvocation(baseEnv: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(WINDOWS_FRONT_WINDOW_SCRIPT, "utf16le").toString("base64"),
    ],
    env: desktopChildEnv(baseEnv, "win32"),
  };
}

/** The JSON line the script prints last into a front window. */
export function parseWindowsFrontWindow(stdout: string): FrontWindowResult {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let raw: Record<string, unknown>;
  try {
    raw = (JSON.parse(line) ?? {}) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "the window in front could not be read" };
  }
  const proc = typeof raw.process === "string" ? raw.process.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const idle = typeof raw.idleMs === "number" && Number.isFinite(raw.idleMs) && raw.idleMs >= 0 ? raw.idleMs : null;
  return {
    ok: true,
    probe: {
      app: proc ? { name: description || proc, bundleId: proc.toLowerCase().replace(/\.exe$/, "") } : null,
      title: typeof raw.title === "string" ? raw.title : "",
      idleMs: idle,
      screenRecording: null,
    },
  };
}

export async function probeWindowsFrontWindow(screen: ScreenDeps, ctx: { workingDir: string; signal: AbortSignal }): Promise<FrontWindowResult> {
  const call = windowsFrontWindowInvocation(screen.env);
  const result = await screen.run(call.command, call.args, { cwd: ctx.workingDir, signal: ctx.signal, timeoutMs: 15_000, env: call.env });
  if (result.exitCode !== 0) return { ok: false, reason: "the window in front could not be read (Windows refuses this while the PC is locked)" };
  return parseWindowsFrontWindow(result.stdout);
}
