import { join } from "node:path";

import { screencaptureArgs } from "../tools/os/screen/screen-capture.js";
import { chooseDesktopCaptureBackend, takeDesktopScreenshot } from "../tools/os/screen/screen-capture-win-linux.js";
import type { ScreenDeps } from "../tools/os/screen/screen-host.js";
import { screenChildEnv } from "../tools/os/screen/screen-jxa.js";

/**
 * One silent screenshot for the logbook, into its private frames folder.
 * macOS: `screencapture -x` as JPEG, shrunk by `sips`. Windows and Linux
 * (ATO-2526): the screen tools' own path (`os.screen.capture`'s
 * PowerShell program, or the first Linux screenshot tool that works),
 * as PNG, already shrunk there. The caller deletes the file.
 */
export const LOGBOOK_IMAGE_MAX_SIDE = 1280;

export type LogbookShot = { ok: true; mimeType: "image/jpeg" | "image/png" } | { ok: false; reason: string };

/** Where this platform's frame is written. */
export function logbookFramePath(screen: ScreenDeps, framesDir: string): string {
  const ext = screen.platform === "darwin" ? "jpg" : "png";
  return join(framesDir, `frame-${screen.now().getTime()}.${ext}`);
}

export async function takeLogbookShot(
  screen: ScreenDeps,
  path: string,
  ctx: { workingDir: string; signal: AbortSignal },
): Promise<LogbookShot> {
  if (screen.platform === "darwin") {
    const env = screenChildEnv(screen.env);
    const shot = await screen.run("screencapture", screencaptureArgs(path), { cwd: ctx.workingDir, signal: ctx.signal, timeoutMs: 20_000, env });
    if (shot.exitCode !== 0) return { ok: false, reason: `screenshot failed: ${shot.stderr.trim() || `exit ${shot.exitCode ?? "none"}`}` };
    // Smaller is faster to describe; a failed shrink still leaves a usable picture.
    await screen.run("sips", ["-Z", String(LOGBOOK_IMAGE_MAX_SIDE), path], { cwd: ctx.workingDir, signal: ctx.signal, timeoutMs: 20_000, env });
    return { ok: true, mimeType: "image/jpeg" };
  }
  const backend = await chooseDesktopCaptureBackend(screen, ctx);
  if (!backend.ok) return { ok: false, reason: backend.message };
  const shot = await takeDesktopScreenshot(screen, backend.backend, path, ctx);
  return shot.ok ? { ok: true, mimeType: "image/png" } : { ok: false, reason: shot.message };
}
