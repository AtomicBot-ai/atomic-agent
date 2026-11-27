import type { KeystrokeCommand } from "./keystroke-clipboard.js";
import type { SourceApp } from "./replace-selection.js";

/**
 * ATO-2738: "Replace in …" on Windows and Linux. replace-selection.ts has
 * the macOS half (the app by pid, JavaScript for Automation); this module
 * has the window in front on the other two, read when the hotkey reads the
 * selection and brought back before Ctrl+V:
 *
 * - Windows: the foreground window's handle (HWND) through PowerShell and
 *   user32, its process for the button's name; SetForegroundWindow brings
 *   it back, and the script says "ok" only when that window really is in
 *   front again, so a Ctrl+V never lands in another window.
 * - Linux on X11: xdotool (getactivewindow, windowactivate --sync).
 * - Linux on Wayland: no program may read or raise another app's window,
 *   so none is remembered. Closing the mini chat gives the keyboard back to
 *   the window under it, and wtype presses Ctrl+V there.
 * - A tool that is not installed: the button still shows and says which
 *   one to install (`blocked`), rather than doing nothing.
 *
 * Pure (no Electron): the commands, the parsers, the names. The host is
 * replace-front-app-host.ts. Precedent: Raycast's "Paste to active app";
 * espanso and AutoKey use the same xdotool / wtype pair on Linux.
 */

export interface FrontEnv {
  platform: NodeJS.Platform | string;
  env: Record<string, string | undefined>;
}

export function isWaylandEnv(env: Record<string, string | undefined>): boolean {
  return !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland";
}

/** The plain lines for a missing tool: what to install, and what to do meanwhile. */
export const LINUX_XDOTOOL_HINT = "To put the answer back in the app, install xdotool (for example: sudo apt install xdotool). Until then, copy the answer and paste it with Ctrl+V.";
export const LINUX_WTYPE_HINT = "To put the answer back in the app, install wtype (for example: sudo apt install wtype). Until then, copy the answer and paste it with Ctrl+V.";

/** Electron's paste chord as the lines write it. */
export function pasteKeyLabel(platform: NodeJS.Platform | string): string {
  return platform === "darwin" ? "⌘V" : "Ctrl+V";
}

/** Is `name` a program on PATH? `exists` is injected (fs.existsSync in the host). */
export function onPath(name: string, env: Record<string, string | undefined>, exists: (path: string) => boolean, sep = ":"): boolean {
  const dirs = String(env.PATH || "").split(sep).filter(Boolean);
  return dirs.some((d) => { try { return exists(d.replace(/\/+$/, "") + "/" + name); } catch { return false; } });
}

/* ---------------- Windows ---------------- */

/*
 * The C# goes in a PowerShell single-quoted string, where '' is one ', so
 * C# would get DllImport('user32.dll'): a char literal, error CS1012, no
 * type, and nothing works. A " is literal there, and Node's execFile quotes
 * it for the command line.
 */
const WIN_USER32 = "Add-Type -Namespace AtomicAgent -Name Front -MemberDefinition '"
  + "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); "
  + "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid); "
  + "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); "
  + "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd); "
  + "[DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr hWnd); "
  + "[DllImport(\"user32.dll\")] public static extern bool IsWindow(System.IntPtr hWnd);';";

const powershell = (script: string): KeystrokeCommand => ({
  file: "powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
});

/** The foreground window as JSON {hwnd, pid, name}. */
export function winFrontCommand(): KeystrokeCommand {
  return powershell([
    WIN_USER32,
    "$h = [AtomicAgent.Front]::GetForegroundWindow(); $fp = [uint32]0; [void][AtomicAgent.Front]::GetWindowThreadProcessId($h, [ref]$fp);",
    "$n = ''; try { $p = Get-Process -Id $fp -ErrorAction Stop; $n = $p.Description; if (-not $n) { $n = $p.ProcessName } } catch {}",
    "[pscustomobject]@{ hwnd = $h.ToInt64().ToString(); pid = [int]$fp; name = [string]$n } | ConvertTo-Json -Compress",
  ].join(" "));
}

/** A window handle that is safe to put in a script: digits only, above 0. */
export function goodHandle(h: unknown): h is string {
  return typeof h === "string" && /^[1-9][0-9]{0,18}$/.test(h);
}

const cleanName = (name: unknown): string => (typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 60) : "");

/** The Windows read, checked. Null for bad output or this app's own window. */
export function parseWinFront(stdout: unknown, ownPid: number): SourceApp | null {
  if (typeof stdout !== "string" || !stdout.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const { hwnd, pid, name } = raw as { hwnd?: unknown; pid?: unknown; name?: unknown };
  if (!goodHandle(hwnd) || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === ownPid) return null;
  return { name: cleanName(name) || "the app", pid, hwnd };
}

/** Brings that window back (restored if minimized); prints "ok" only when it is in front. Null for a bad handle. */
export function winActivateCommand(hwnd: string): KeystrokeCommand | null {
  if (!goodHandle(hwnd)) return null;
  return powershell([
    WIN_USER32,
    `$h = [System.IntPtr]::new([Int64]${hwnd});`,
    "if (-not [AtomicAgent.Front]::IsWindow($h)) { 'gone'; exit 0 };",
    "if ([AtomicAgent.Front]::IsIconic($h)) { [void][AtomicAgent.Front]::ShowWindow($h, 9) };",
    "[void][AtomicAgent.Front]::SetForegroundWindow($h); Start-Sleep -Milliseconds 60;",
    "if ([AtomicAgent.Front]::GetForegroundWindow() -eq $h) { 'ok' } else { 'no' }",
  ].join(" "));
}

/* ---------------- Linux, X11 ---------------- */

export const X11_ACTIVE_WINDOW: KeystrokeCommand = { file: "xdotool", args: ["getactivewindow"] };

/** An X window id that is safe to pass on: digits only. */
export function goodXid(x: unknown): x is string {
  return typeof x === "string" && /^[1-9][0-9]{0,12}$/.test(x);
}

export function parseXid(stdout: unknown): string | null {
  const s = typeof stdout === "string" ? stdout.trim() : "";
  return goodXid(s) ? s : null;
}

export function x11NameCommand(xid: string): KeystrokeCommand | null {
  return goodXid(xid) ? { file: "xdotool", args: ["getwindowname", xid] } : null;
}

export function x11PidCommand(xid: string): KeystrokeCommand | null {
  return goodXid(xid) ? { file: "xdotool", args: ["getwindowpid", xid] } : null;
}

export function x11ActivateCommand(xid: string): KeystrokeCommand | null {
  return goodXid(xid) ? { file: "xdotool", args: ["windowactivate", "--sync", xid] } : null;
}

/**
 * An app's name from its window title, for the button: "Notes - Mozilla
 * Firefox" is "Mozilla Firefox", the part after the last " - " (or long
 * dash). A title with no such part is used whole.
 */
export function appNameFromTitle(title: unknown): string {
  const t = cleanName(typeof title === "string" ? title.replace(/\s+/g, " ") : "");
  if (!t) return "";
  const parts = t.split(/\s[-\u2013\u2014]\s/);
  const last = parts[parts.length - 1].trim();
  return (last || t).slice(0, 60);
}

/* ---------------- one answer per platform ---------------- */

/** What the read gives on Linux before any command runs: Wayland, or a missing tool. Null: read the X11 window. */
export function linuxFrontPlan(o: FrontEnv, has: (tool: string) => boolean): SourceApp | null {
  if (isWaylandEnv(o.env)) {
    return has("wtype") ? { name: "", pid: 0, wayland: true } : { name: "", pid: 0, blocked: LINUX_WTYPE_HINT };
  }
  if (!o.env.DISPLAY) return { name: "", pid: 0, blocked: LINUX_XDOTOOL_HINT };
  return has("xdotool") ? null : { name: "", pid: 0, blocked: LINUX_XDOTOOL_HINT };
}

/** How long the window brought back gets before Ctrl+V: longer on Wayland, where it is the compositor's to give back. */
export function replaceFocusMs(source: SourceApp | null): number {
  return source && source.wayland ? 350 : 150;
}
