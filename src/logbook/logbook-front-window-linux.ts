import { desktopChildEnv, linuxSessionKind, linuxWhichInvocation } from "../tools/os/screen/screen-capture-win-linux.js";
import type { ScreenDeps } from "../tools/os/screen/screen-host.js";
import type { FrontWindowResult } from "./logbook-front-window.js";

/**
 * The window in front on Linux (ATO-2526). Only an X11 session can say
 * which window is active; on Wayland no tool may ask, so the logbook
 * stays off there and says how to use it. On X11:
 *
 * - `xprop` (preferred): `-root _NET_ACTIVE_WINDOW` gives the window id,
 *   then `-id <id> WM_CLASS _NET_WM_NAME WM_NAME` its class and title;
 * - else `xdotool getactivewindow getwindowclassname getwindowname`.
 *
 * The id is the window class's first part (the instance, lower case),
 * which is what `DESKTOP_PROTECTED_APPS` lists. `xprintidle`, when
 * present, says how long since the last input. Every command has a fixed
 * argv; the only variable is the window id that xprop itself printed.
 */
export const WAYLAND_REASON =
  "On Wayland the logbook cannot see which window is in front, so it takes no screenshots. Log in to an Xorg (X11) session to use it.";
export const NO_DISPLAY_REASON = "No graphical session is visible to the agent, so there is no screen to note.";
export const NO_X11_TOOL_REASON =
  "The logbook needs xprop or xdotool to see which window is in front. Install one (for example: sudo apt install x11-utils), then it starts on its own.";

type Run = (command: string, args: string[]) => Promise<{ exitCode: number | null; stdout: string }>;

/** `WM_CLASS(STRING) = "keepassxc", "KeePassXC"` and the names, from xprop's output. */
export function parseXpropWindow(stdout: string): { instance: string; className: string; title: string } {
  const cls = /WM_CLASS\([^)]*\)\s*=\s*"([^"]*)"(?:,\s*"([^"]*)")?/.exec(stdout);
  const netName = /_NET_WM_NAME\([^)]*\)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(stdout);
  const wmName = /\bWM_NAME\([^)]*\)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(stdout);
  const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
  return {
    instance: cls?.[1] ?? "",
    className: cls?.[2] ?? cls?.[1] ?? "",
    title: unescape(netName?.[1] ?? wmName?.[1] ?? ""),
  };
}

/** `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007` into `0x3a00007`; `null` for none (`0x0`). */
export function parseActiveWindowId(stdout: string): string | null {
  const id = /#\s*(0x[0-9a-f]+)/i.exec(stdout)?.[1] ?? null;
  return id && !/^0x0+$/i.test(id) ? id : null;
}

function app(instance: string, className: string) {
  const id = (instance || className).trim().toLowerCase();
  return id ? { name: className.trim() || instance.trim(), bundleId: id } : null;
}

export async function probeLinuxFrontWindow(screen: ScreenDeps, ctx: { workingDir: string; signal: AbortSignal }): Promise<FrontWindowResult> {
  const kind = linuxSessionKind(screen.env);
  if (kind === "wayland") return { ok: false, reason: WAYLAND_REASON };
  if (kind === "none") return { ok: false, reason: NO_DISPLAY_REASON };
  const env = desktopChildEnv(screen.env, "linux");
  const run: Run = (command, args) => screen.run(command, args, { cwd: ctx.workingDir, signal: ctx.signal, timeoutMs: 5_000, env });
  const which = linuxWhichInvocation(["xprop", "xdotool", "xprintidle"]);
  const found = new Set((await run(which.command, which.args)).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const idleMs = found.has("xprintidle") ? await readIdle(run) : null;
  if (found.has("xprop")) {
    const root = await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
    const id = root.exitCode === 0 ? parseActiveWindowId(root.stdout) : null;
    if (!id) return { ok: true, probe: { app: null, title: "", idleMs, screenRecording: null } };
    const win = await run("xprop", ["-id", id, "WM_CLASS", "_NET_WM_NAME", "WM_NAME"]);
    const parsed = parseXpropWindow(win.exitCode === 0 ? win.stdout : "");
    return { ok: true, probe: { app: app(parsed.instance, parsed.className), title: parsed.title, idleMs, screenRecording: null } };
  }
  if (found.has("xdotool")) {
    const out = await run("xdotool", ["getactivewindow", "getwindowclassname", "getwindowname"]);
    const [cls = "", title = ""] = out.exitCode === 0 ? out.stdout.split(/\r?\n/) : [];
    return { ok: true, probe: { app: app(cls, cls), title: title.trim(), idleMs, screenRecording: null } };
  }
  return { ok: false, reason: NO_X11_TOOL_REASON };
}

async function readIdle(run: Run): Promise<number | null> {
  const out = await run("xprintidle", []);
  const ms = Number(out.stdout.trim());
  return out.exitCode === 0 && Number.isFinite(ms) && ms >= 0 ? ms : null;
}
