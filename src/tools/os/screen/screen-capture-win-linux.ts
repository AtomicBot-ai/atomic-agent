import { SCREENSHOT_MAX_SIDE, fitWithin } from "./screen-geometry.js";
import type { ScreenDeps } from "./screen-host.js";

/**
 * `os.screen.capture` on Windows and Linux (ATO-527, first slice: look
 * only). The whole screen, every display, saved as a PNG next to the
 * macOS captures. Clicking, typing, keys and pointing stay macOS-only.
 *
 * - Windows: one constant PowerShell program (`System.Windows.Forms` /
 *   `System.Drawing` `CopyFromScreen` of the virtual screen). The output
 *   path and the size cap travel in environment variables, never in the
 *   script text, and the script is sent as `-EncodedCommand`, so nothing
 *   is quoted or spliced. It calls `SetProcessDPIAware` first, so a
 *   scaled display is captured in physical pixels, not cropped to the
 *   logical size. It downscales inside the script and prints a JSON report.
 * - Linux: the first screenshot tool on PATH that works, in the order of
 *   `linuxCaptureCandidates`. Each is run with a fixed argv; the only
 *   variable is the output path, which the agent builds itself. The
 *   picture's size comes from the PNG header; ImageMagick (`magick` or
 *   `convert`), when present, downscales it.
 *
 * Every command gets an allow-listed environment, so no provider key or
 * token reaches the child.
 */

export type DesktopCaptureTool =
  | "powershell"
  | "grim"
  | "gnome-screenshot"
  | "spectacle"
  | "scrot"
  | "import";

/** Environment variable that carries the Windows output path. */
export const WINDOWS_CAPTURE_OUT_ENV = "ATOMIC_SCREEN_OUT";
/** Environment variable that carries the long-side cap, in pixels. */
export const WINDOWS_CAPTURE_MAX_SIDE_ENV = "ATOMIC_SCREEN_MAX_SIDE";

/**
 * A finished picture over this many bytes is refused rather than handed
 * on: it would only fail later in `vision.describe` or a chat upload.
 * Hit on Linux without ImageMagick on a very large desktop.
 */
export const DESKTOP_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;

export const DESKTOP_CAPTURE_TIMEOUT_MS = 20_000;

/**
 * The Windows capture program. Constant: what varies is read from
 * `$env:ATOMIC_SCREEN_OUT` and `$env:ATOMIC_SCREEN_MAX_SIDE`.
 *
 * `SetProcessDPIAware` must come before any screen metric is read, or a
 * 150% display reports (and captures) only two thirds of itself. The
 * virtual screen spans every monitor; its top-left can be negative when
 * a monitor sits left of or above the primary one, and the report keeps
 * that origin. A locked workstation, the UAC secure desktop or a session
 * with no interactive desktop (a service, an SSH login) makes
 * `CopyFromScreen` throw; the error reaches stderr and the exit code.
 */
export const WINDOWS_CAPTURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class AtomicDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
  "[void][AtomicDpi]::SetProcessDPIAware()",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$out = $env:ATOMIC_SCREEN_OUT",
  "if ([string]::IsNullOrEmpty($out)) { throw 'ATOMIC_SCREEN_OUT is not set' }",
  "$max = 0",
  "[void][int]::TryParse([string]$env:ATOMIC_SCREEN_MAX_SIDE, [ref]$max)",
  "$v = [System.Windows.Forms.SystemInformation]::VirtualScreen",
  "if ($v.Width -le 0 -or $v.Height -le 0) { throw 'no display to capture' }",
  "$bmp = New-Object System.Drawing.Bitmap $v.Width, $v.Height",
  "$g = [System.Drawing.Graphics]::FromImage($bmp)",
  "try { $g.CopyFromScreen($v.Left, $v.Top, 0, 0, $bmp.Size) } finally { $g.Dispose() }",
  "$w = $v.Width",
  "$h = $v.Height",
  "$img = $bmp",
  "$long = [Math]::Max($w, $h)",
  "if ($max -gt 0 -and $long -gt $max) {",
  "  $w = [int][Math]::Round($v.Width * $max / $long)",
  "  $h = [int][Math]::Round($v.Height * $max / $long)",
  "  $img = New-Object System.Drawing.Bitmap $w, $h",
  "  $g2 = [System.Drawing.Graphics]::FromImage($img)",
  "  try {",
  "    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "    $g2.DrawImage($bmp, 0, 0, $w, $h)",
  "  } finally { $g2.Dispose() }",
  "  $bmp.Dispose()",
  "}",
  "try { $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }",
  "@{ left = $v.Left; top = $v.Top; screenWidth = $v.Width; screenHeight = $v.Height; imageWidth = $w; imageHeight = $h } | ConvertTo-Json -Compress",
].join("\n");

/** `powershell.exe -EncodedCommand`: base64 of the UTF-16LE script, so no argv quoting applies. */
export function windowsCaptureInvocation(
  path: string,
  baseEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = desktopChildEnv(baseEnv, "win32");
  env[WINDOWS_CAPTURE_OUT_ENV] = path;
  env[WINDOWS_CAPTURE_MAX_SIDE_ENV] = String(SCREENSHOT_MAX_SIDE);
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(WINDOWS_CAPTURE_SCRIPT, "utf16le").toString("base64"),
    ],
    env,
  };
}

export interface DesktopCaptureReport {
  /** Top-left of the captured area, in screen pixels (Windows: can be negative). */
  originX: number;
  originY: number;
  screenWidth: number;
  screenHeight: number;
  imageWidth: number;
  imageHeight: number;
}

/** The JSON line the Windows script prints last; throws on anything else. */
export function parseWindowsCaptureReport(stdout: string): DesktopCaptureReport {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`unexpected PowerShell output: ${stdout.trim().slice(0, 200)}`);
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const [left, top, sw, sh, iw, ih] = [
    obj.left,
    obj.top,
    obj.screenWidth,
    obj.screenHeight,
    obj.imageWidth,
    obj.imageHeight,
  ].map(Number) as [number, number, number, number, number, number];
  if (![left, top].every(Number.isFinite) || ![sw, sh, iw, ih].every((n) => n > 0)) {
    throw new Error(`PowerShell reported no usable screen size: ${line.slice(0, 200)}`);
  }
  return { originX: left, originY: top, screenWidth: sw, screenHeight: sh, imageWidth: iw, imageHeight: ih };
}

/** Linux screenshot tools, in the order they are tried. */
export const LINUX_CAPTURE_TOOLS = ["grim", "gnome-screenshot", "spectacle", "scrot", "import"] as const;
export type LinuxCaptureTool = (typeof LINUX_CAPTURE_TOOLS)[number];

/** ImageMagick front ends that can downscale the picture, best first. */
export const LINUX_RESIZE_TOOLS = ["magick", "convert"] as const;

/** Wayland or X11, from the session's own variables. */
export function linuxSessionKind(env: NodeJS.ProcessEnv): "wayland" | "x11" | "none" {
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") return "wayland";
  if (env.DISPLAY) return "x11";
  return "none";
}

/**
 * The tools worth trying for this session, in order. On Wayland the X11
 * tools are left out: through XWayland they see only X11 windows and
 * return a mostly black picture. `grim` needs a wlroots compositor
 * (Sway, Hyprland, river, ...); KDE has `spectacle`. GNOME on Wayland
 * refuses all of them (its screenshot D-Bus API is private since GNOME
 * 41 and the portal asks the user every time), which the missing-tool
 * message says.
 */
export function linuxCaptureCandidates(kind: "wayland" | "x11" | "none"): readonly LinuxCaptureTool[] {
  if (kind === "wayland") return ["grim", "gnome-screenshot", "spectacle"];
  if (kind === "x11") return ["gnome-screenshot", "spectacle", "scrot", "import"];
  return [];
}

/** Fixed argv per tool; `path` is the only variable and the agent builds it. */
export function linuxCaptureArgs(tool: LinuxCaptureTool, path: string): string[] {
  switch (tool) {
    case "grim":
      return ["-t", "png", path];
    case "gnome-screenshot":
      return ["-f", path];
    case "spectacle":
      // background, no notification, full screen, output file
      return ["-b", "-n", "-f", "-o", path];
    case "scrot":
      return [path];
    case "import":
      return ["-window", "root", path];
  }
}

/** `<magick|convert> <path> -resize 1280x1280> <path>`: shrink only, keep the aspect ratio. */
export function linuxResizeArgs(path: string, maxSide: number = SCREENSHOT_MAX_SIDE): string[] {
  return [path, "-resize", `${maxSide}x${maxSide}>`, path];
}

/**
 * `sh -c` with a constant loop: prints every name in `$@` that
 * `command -v` finds, one per line. The names are constants, passed as
 * argv; nothing from the model reaches the shell.
 */
export const LINUX_WHICH_SCRIPT =
  'for t in "$@"; do command -v "$t" >/dev/null 2>&1 && printf "%s\\n" "$t"; done; exit 0';

export function linuxWhichInvocation(names: readonly string[]): { command: string; args: string[] } {
  return { command: "sh", args: ["-c", LINUX_WHICH_SCRIPT, "sh", ...names] };
}

export function linuxMissingToolMessage(kind: "wayland" | "x11" | "none", tried: readonly string[] = []): string {
  if (kind === "none") {
    return (
      "No graphical session is visible to the agent (neither WAYLAND_DISPLAY nor DISPLAY is set), so there is no screen to capture. " +
      "This happens over SSH, in a container or under a service. Nothing was captured: ask the user to describe what they see."
    );
  }
  const failed = tried.length > 0 ? ` Tried ${tried.join(", ")}; none produced a picture.` : "";
  const install =
    kind === "wayland"
      ? "On Sway, Hyprland or another wlroots compositor install `grim`; on KDE Plasma install `spectacle`."
      : "Install one of `gnome-screenshot`, `spectacle` (KDE), `scrot` or ImageMagick (`import`).";
  return (
    `No working screenshot tool was found on this Linux ${kind === "wayland" ? "Wayland" : "X11"} session.${failed} ${install} ` +
    "GNOME on Wayland blocks these tools: there a screenshot needs the desktop portal, which this version does not use yet; logging in to a \"GNOME on Xorg\" session with `gnome-screenshot` installed works. " +
    "Nothing was captured: tell the user what to install, or ask them to describe what they see."
  );
}

/** Width and height from a PNG's IHDR chunk; `null` when the bytes are not a PNG. */
export function parsePngSize(head: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length < 24 || !signature.every((byte, i) => head[i] === byte)) return null;
  if (String.fromCharCode(head[12]!, head[13]!, head[14]!, head[15]!) !== "IHDR") return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const WINDOWS_ENV_KEYS = [
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "SystemDrive",
  "PATH",
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PSModulePath",
  "ComSpec",
  "COMSPEC",
  "ProgramFiles",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

const LINUX_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/**
 * What a capture child may see: the variables a desktop needs to find
 * the display and the system, nothing else (no provider keys, tokens or
 * the agent's own settings).
 */
export function desktopChildEnv(baseEnv: NodeJS.ProcessEnv, os: "win32" | "linux"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Windows names are case-insensitive (`Path` and `PATH` are one
  // variable, and `process.env` answers to both): keep the first spelling only.
  const seen = new Set<string>();
  for (const key of os === "win32" ? WINDOWS_ENV_KEYS : LINUX_ENV_KEYS) {
    const id = os === "win32" ? key.toUpperCase() : key;
    const value = baseEnv[key];
    if (value === undefined || seen.has(id)) continue;
    seen.add(id);
    env[key] = value;
  }
  return env;
}

export type DesktopCaptureBackend =
  | { os: "win32"; tool: "powershell"; label: string }
  | {
      os: "linux";
      tool: LinuxCaptureTool;
      label: string;
      /** The other available tools, tried in order when this one fails. */
      fallbacks: LinuxCaptureTool[];
      resizer: (typeof LINUX_RESIZE_TOOLS)[number] | null;
    };

export type DesktopBackendChoice =
  | { ok: true; backend: DesktopCaptureBackend }
  | { ok: false; message: string; reason: "no-capture-tool" | "no-display" };

interface RunCtx {
  workingDir: string;
  signal: AbortSignal;
}

/**
 * Which program will take the picture. Runs before the approval prompt,
 * so a missing tool is reported without asking the user anything.
 */
export async function chooseDesktopCaptureBackend(
  deps: ScreenDeps,
  ctx: RunCtx,
): Promise<DesktopBackendChoice> {
  if (deps.platform === "win32") {
    return { ok: true, backend: { os: "win32", tool: "powershell", label: "PowerShell (System.Drawing)" } };
  }
  const kind = linuxSessionKind(deps.env);
  const candidates = linuxCaptureCandidates(kind);
  if (candidates.length === 0) {
    return { ok: false, message: linuxMissingToolMessage("none"), reason: "no-display" };
  }
  const which = linuxWhichInvocation([...candidates, ...LINUX_RESIZE_TOOLS]);
  const found = await deps.run(which.command, which.args, {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: 5_000,
    env: desktopChildEnv(deps.env, "linux"),
  });
  const names = new Set(found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const available = candidates.filter((tool) => names.has(tool));
  if (available.length === 0) {
    return { ok: false, message: linuxMissingToolMessage(kind), reason: "no-capture-tool" };
  }
  const [tool, ...fallbacks] = available as [LinuxCaptureTool, ...LinuxCaptureTool[]];
  const resizer = LINUX_RESIZE_TOOLS.find((name) => names.has(name)) ?? null;
  return { ok: true, backend: { os: "linux", tool, label: tool, fallbacks, resizer } };
}

export type DesktopShot =
  | {
      ok: true;
      report: DesktopCaptureReport;
      bytes: number;
      /** The tool that actually took it (a Linux fallback may have). */
      tool: string;
      /** False when the picture is larger than the cap and nothing could shrink it. */
      downscaled: boolean;
    }
  | { ok: false; message: string; reason: "capture-failed" | "no-capture-tool" | "too-large" };

/** Take the picture into `path` with the chosen backend (approval already given). */
export async function takeDesktopScreenshot(
  deps: ScreenDeps,
  backend: DesktopCaptureBackend,
  path: string,
  ctx: RunCtx,
): Promise<DesktopShot> {
  const shot = backend.os === "win32"
    ? await takeWindowsScreenshot(deps, path, ctx)
    : await takeLinuxScreenshot(deps, backend, path, ctx);
  if (!shot.ok) return shot;
  if (shot.bytes > DESKTOP_CAPTURE_MAX_BYTES) {
    return {
      ok: false,
      reason: "too-large",
      message:
        `the screenshot is ${Math.round(shot.bytes / 1024 / 1024)} MB (${shot.report.imageWidth}x${shot.report.imageHeight} px), ` +
        `over the ${DESKTOP_CAPTURE_MAX_BYTES / 1024 / 1024} MB limit, so it was not handed on` +
        (backend.os === "linux" && !backend.resizer ? "; installing ImageMagick lets the agent shrink it" : ""),
    };
  }
  return shot;
}

async function takeWindowsScreenshot(deps: ScreenDeps, path: string, ctx: RunCtx): Promise<DesktopShot> {
  const call = windowsCaptureInvocation(path, deps.env);
  const result = await deps.run(call.command, call.args, {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: DESKTOP_CAPTURE_TIMEOUT_MS,
    env: call.env,
  });
  const bytes = result.exitCode === 0 ? await deps.fileSize(path).catch(() => 0) : 0;
  if (bytes === 0) {
    const why = result.stderr.trim().split(/\r?\n/)[0] || `PowerShell exit ${result.exitCode ?? "none"}`;
    return {
      ok: false,
      reason: "capture-failed",
      message:
        `screenshot failed: ${why.slice(0, 300)}. Windows refuses screen capture while the PC is locked, ` +
        "on the administrator (UAC) prompt, and from a session with no desktop (a service or an SSH login).",
    };
  }
  let report: DesktopCaptureReport;
  try {
    report = parseWindowsCaptureReport(result.stdout);
  } catch (error) {
    return { ok: false, reason: "capture-failed", message: `screenshot failed: ${(error as Error).message}` };
  }
  return { ok: true, report, bytes, tool: "powershell", downscaled: fitWithin(report.screenWidth, report.screenHeight).resize };
}

async function takeLinuxScreenshot(
  deps: ScreenDeps,
  backend: Extract<DesktopCaptureBackend, { os: "linux" }>,
  path: string,
  ctx: RunCtx,
): Promise<DesktopShot> {
  const env = desktopChildEnv(deps.env, "linux");
  const run = (command: string, args: string[]) =>
    deps.run(command, args, { cwd: ctx.workingDir, signal: ctx.signal, timeoutMs: DESKTOP_CAPTURE_TIMEOUT_MS, env });
  const tried: string[] = [];
  const errors: string[] = [];
  for (const tool of [backend.tool, ...backend.fallbacks]) {
    tried.push(tool);
    const result = await run(tool, linuxCaptureArgs(tool, path));
    const bytes = result.exitCode === 0 ? await deps.fileSize(path).catch(() => 0) : 0;
    const size = bytes > 0 ? parsePngSize(await deps.readHead(path, 24).catch(() => new Uint8Array())) : null;
    if (!size) {
      const why = result.stderr.trim().split(/\r?\n/)[0] || `exit ${result.exitCode ?? "none"}`;
      errors.push(`${tool}: ${why.slice(0, 160)}`);
      continue;
    }
    let image = size;
    let finalBytes = bytes;
    let downscaled = false;
    if (fitWithin(size.width, size.height).resize && backend.resizer) {
      const resized = await run(backend.resizer, linuxResizeArgs(path));
      const after = resized.exitCode === 0
        ? parsePngSize(await deps.readHead(path, 24).catch(() => new Uint8Array()))
        : null;
      if (after) {
        image = after;
        finalBytes = await deps.fileSize(path).catch(() => bytes);
        downscaled = true;
      }
    }
    return {
      ok: true,
      tool,
      bytes: finalBytes,
      downscaled,
      report: {
        originX: 0,
        originY: 0,
        screenWidth: size.width,
        screenHeight: size.height,
        imageWidth: image.width,
        imageHeight: image.height,
      },
    };
  }
  const kind = linuxSessionKind(deps.env);
  return {
    ok: false,
    reason: "capture-failed",
    message: `${linuxMissingToolMessage(kind === "none" ? "x11" : kind, tried)} Errors: ${errors.join("; ")}`,
  };
}
