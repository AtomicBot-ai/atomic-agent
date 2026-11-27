import { join } from "node:path";

import { maskSecrets } from "../error-reporting/secret-detector.js";
import { screencaptureArgs } from "../tools/os/screen/screen-capture.js";
import { runScreenOp, screenRecordingMessage, type ScreenDeps } from "../tools/os/screen/screen-host.js";
import { screenChildEnv } from "../tools/os/screen/screen-jxa.js";
import type { LogbookVisionProvider } from "./logbook-local-vision.js";
import { logbookSkipReason } from "./logbook-skip.js";
import type { LogbookEntry } from "./logbook-store.js";

/**
 * One logbook frame: look at which app is in front, skip a protected
 * one, take a silent screenshot into the private frames folder, shrink
 * it, have the LOCAL model describe it in a sentence or two, and delete
 * the picture in every case, before this function returns. The front
 * app is checked again right after the shot, so a switch to a password
 * manager in between throws the picture away undescribed.
 */
export const LOGBOOK_PROMPT =
  "This is a screenshot of the person's screen. In one or two short sentences, say what they are working on: the app, the document, page, code or conversation topic, and the task. " +
  "Do not copy passwords, keys, card numbers, addresses or whole messages. Answer with plain text only.";

/** Longest stored observation. */
export const LOGBOOK_TEXT_MAX = 400;
/** Longest side of the picture sent to the model, in pixels. */
export const LOGBOOK_IMAGE_MAX_SIDE = 1280;

export interface LogbookCaptureDeps {
  screen: ScreenDeps;
  /** Private folder (0700) the frame lives in for the seconds it takes to describe it. */
  framesDir: string;
  readFile: (path: string) => Promise<Uint8Array>;
  removeFile: (path: string) => Promise<void>;
  workingDir: string;
}

export type LogbookCaptureOutcome =
  | { kind: "captured"; entry: LogbookEntry }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; reason: string };

/** One line, secrets masked, capped. */
export function cleanObservation(text: string): string {
  const flat = maskSecrets(text.replace(/\s+/g, " ").trim());
  return flat.length <= LOGBOOK_TEXT_MAX ? flat : `${flat.slice(0, LOGBOOK_TEXT_MAX - 1)}…`;
}

export async function captureLogbookFrame(
  deps: LogbookCaptureDeps,
  provider: LogbookVisionProvider,
  excludeApps: readonly string[],
  signal: AbortSignal,
): Promise<LogbookCaptureOutcome> {
  const { screen } = deps;
  if (screen.platform !== "darwin") {
    return { kind: "skipped", reason: "the logbook takes screenshots on macOS only for now" };
  }
  const ctx = { workingDir: deps.workingDir, signal };
  const before = await runScreenOp(screen, { op: "probe" }, ctx);
  if (before.screenRecording === false) return { kind: "error", reason: screenRecordingMessage(screen.env) };
  const skip = logbookSkipReason(before.frontmost, excludeApps);
  if (skip !== null) return { kind: "skipped", reason: skip };

  await screen.ensureDir(deps.framesDir);
  const path = join(deps.framesDir, `frame-${screen.now().getTime()}.jpg`);
  const env = screenChildEnv(screen.env);
  try {
    const shot = await screen.run("screencapture", screencaptureArgs(path), {
      cwd: deps.workingDir,
      signal,
      timeoutMs: 20_000,
      env,
    });
    if (shot.exitCode !== 0) {
      return { kind: "error", reason: `screenshot failed: ${shot.stderr.trim() || `exit ${shot.exitCode ?? "none"}`}` };
    }
    const after = await runScreenOp(screen, { op: "probe" }, ctx);
    const skipAfter = logbookSkipReason(after.frontmost, excludeApps);
    if (skipAfter !== null) return { kind: "skipped", reason: skipAfter };
    // Smaller is faster to describe; a failed shrink still leaves a usable picture.
    await screen.run("sips", ["-Z", String(LOGBOOK_IMAGE_MAX_SIDE), path], {
      cwd: deps.workingDir,
      signal,
      timeoutMs: 20_000,
      env,
    });
    const bytes = await deps.readFile(path);
    if (bytes.byteLength === 0) return { kind: "error", reason: "the screenshot came out empty" };
    const result = await provider.describeImage({
      prompt: LOGBOOK_PROMPT,
      images: [{ id: 1, bytes, mimeType: "image/jpeg" }],
      maxTokens: 160,
      temperature: 0.2,
      signal,
    });
    const text = cleanObservation(result.text);
    if (!text) return { kind: "skipped", reason: "the model said nothing about the screen" };
    return {
      kind: "captured",
      entry: {
        at: screen.now().toISOString(),
        app: before.frontmost?.name ?? null,
        bundleId: before.frontmost?.bundleId ?? null,
        text,
      },
    };
  } catch (err) {
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await deps.removeFile(path).catch(() => undefined);
  }
}
