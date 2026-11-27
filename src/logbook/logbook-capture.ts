import { maskSecrets } from "../error-reporting/secret-detector.js";
import { screenRecordingMessage, type ScreenDeps } from "../tools/os/screen/screen-host.js";
import { probeFrontWindow } from "./logbook-front-window.js";
import type { LogbookVisionProvider } from "./logbook-local-vision.js";
import type { LogbookSettings } from "./logbook-settings.js";
import { logbookFramePath, takeLogbookShot } from "./logbook-shot.js";
import { appListMatches, logbookSkipReason, type FrontApp } from "./logbook-skip.js";
import type { LogbookEntry } from "./logbook-store.js";

export { LOGBOOK_IMAGE_MAX_SIDE } from "./logbook-shot.js";

/**
 * One logbook frame: look at which window is in front, skip a protected
 * one, take a silent screenshot into the private frames folder, have
 * the LOCAL model describe it in a sentence or two, and delete the
 * picture in every case, before this function returns. The front app is
 * checked again right after the shot, so a switch to a password manager
 * in between throws the picture away undescribed.
 *
 * ATO-2526: macOS, Windows and Linux (X11) (`logbook-front-window.ts`,
 * `logbook-shot.ts`); no frame while the person has not touched the
 * mouse or keyboard for `idleSkipMs` (nothing changed worth a note); and
 * for the apps in `titleOnlyApps` only the app and its window title are
 * noted, with no screenshot and no model call.
 */
export const LOGBOOK_PROMPT =
  "This is a screenshot of the person's screen. In one or two short sentences, say what they are working on: the app, the document, page, code or conversation topic, and the task. " +
  "Do not copy passwords, keys, card numbers, addresses or whole messages. Answer with plain text only.";

/** Longest stored observation. */
export const LOGBOOK_TEXT_MAX = 400;
/** No input for at least this long skips a frame, whatever the interval (ActivityWatch's AFK watcher waits 3 min). */
export const MIN_IDLE_SKIP_MS = 5 * 60_000;
export const IDLE_REASON = "nobody used the mouse or keyboard since the last note, so nothing was captured";

export interface LogbookCaptureDeps {
  screen: ScreenDeps;
  /** Private folder (0700) the frame lives in for the seconds it takes to describe it. */
  framesDir: string;
  readFile: (path: string) => Promise<Uint8Array>;
  removeFile: (path: string) => Promise<void>;
  workingDir: string;
}

export interface LogbookCaptureOptions {
  excludeApps: readonly string[];
  titleOnlyApps: readonly string[];
  /** Skip the frame after this much idle time; `null` never skips. */
  idleSkipMs: number | null;
}

export type LogbookCaptureOutcome =
  | { kind: "captured"; entry: LogbookEntry }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; reason: string };

/** The options one frame takes from the settings: idle means no input for a whole interval (at least 5 min). */
export function logbookCaptureOptions(settings: LogbookSettings): LogbookCaptureOptions {
  return {
    excludeApps: settings.excludeApps,
    titleOnlyApps: settings.titleOnlyApps,
    idleSkipMs: Math.max(MIN_IDLE_SKIP_MS, settings.intervalMinutes * 60_000),
  };
}

/** One line, secrets masked, capped. */
export function cleanObservation(text: string): string {
  const flat = maskSecrets(text.replace(/\s+/g, " ").trim());
  return flat.length <= LOGBOOK_TEXT_MAX ? flat : `${flat.slice(0, LOGBOOK_TEXT_MAX - 1)}…`;
}

/** The note for a title-only app: its name and window title, never more. */
export function titleOnlyText(app: FrontApp, title: string): string {
  const name = app.name ?? app.bundleId ?? "an app";
  const clean = title.replace(/\s+/g, " ").trim();
  return cleanObservation(clean ? `In ${name}: "${clean}" (title only, no screenshot)` : `In ${name} (title only, no screenshot)`);
}

function entry(screen: ScreenDeps, app: FrontApp | null, text: string): LogbookCaptureOutcome {
  return { kind: "captured", entry: { at: screen.now().toISOString(), app: app?.name ?? null, bundleId: app?.bundleId ?? null, text } };
}

export async function captureLogbookFrame(
  deps: LogbookCaptureDeps,
  provider: LogbookVisionProvider,
  options: LogbookCaptureOptions,
  signal: AbortSignal,
): Promise<LogbookCaptureOutcome> {
  const { screen } = deps;
  const ctx = { workingDir: deps.workingDir, signal };
  const before = await probeFrontWindow(screen, ctx, { withTitle: options.titleOnlyApps.length > 0 });
  if (!before.ok) return { kind: "skipped", reason: before.reason };
  const front = before.probe;
  if (front.screenRecording === false) return { kind: "error", reason: screenRecordingMessage(screen.env) };
  if (options.idleSkipMs !== null && front.idleMs !== null && front.idleMs >= options.idleSkipMs) return { kind: "skipped", reason: IDLE_REASON };
  const skip = logbookSkipReason(front.app, options.excludeApps);
  if (skip !== null) return { kind: "skipped", reason: skip };
  if (front.app && appListMatches(front.app, options.titleOnlyApps)) return entry(screen, front.app, titleOnlyText(front.app, front.title));

  await screen.ensureDir(deps.framesDir);
  const path = logbookFramePath(screen, deps.framesDir);
  try {
    const shot = await takeLogbookShot(screen, path, ctx);
    if (!shot.ok) return { kind: "error", reason: shot.reason };
    const after = await probeFrontWindow(screen, ctx, { withTitle: false });
    if (!after.ok) return { kind: "skipped", reason: after.reason };
    const skipAfter = logbookSkipReason(after.probe.app, options.excludeApps);
    if (skipAfter !== null) return { kind: "skipped", reason: skipAfter };
    const bytes = await deps.readFile(path);
    if (bytes.byteLength === 0) return { kind: "error", reason: "the screenshot came out empty" };
    const result = await provider.describeImage({
      prompt: LOGBOOK_PROMPT,
      images: [{ id: 1, bytes, mimeType: shot.mimeType }],
      maxTokens: 160,
      temperature: 0.2,
      signal,
    });
    const text = cleanObservation(result.text);
    if (!text) return { kind: "skipped", reason: "the model said nothing about the screen" };
    return entry(screen, front.app, text);
  } catch (err) {
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await deps.removeFile(path).catch(() => undefined);
  }
}
