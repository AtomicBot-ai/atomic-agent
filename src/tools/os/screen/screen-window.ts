/**
 * One app window as a picture (ATO-532): which window `os.screen.capture
 * { app, window }` means, and which windows it never takes.
 *
 * A window snapshot only looks. It posts no click, key or text, so the
 * look-only rule for browsers and the no-typing rule for terminals from
 * `screen-protected.ts` hold as they are: their windows may be captured,
 * exactly like the whole-display capture already shows them. Windows of
 * the credential and security apps are refused, because a single window
 * of a password manager or a login prompt is nothing but secrets.
 */

export interface ScreenWindow {
  /** `kCGWindowNumber`: what `screencapture -l` takes. */
  id: number;
  pid: number;
  app: string | null;
  bundleId: string | null;
  /** Empty when macOS hides titles (no Screen Recording grant) or the window has none. */
  title: string;
  /** Global screen points, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Apps whose windows are never captured or read on their own. */
export const WINDOW_CAPTURE_REFUSED_BUNDLE_IDS: readonly string[] = [
  "com.apple.keychainaccess",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
];

/** Why this app's window is not captured, or `null` when it may be (still behind the approval). */
export function windowCaptureRefusal(bundleId: string | null | undefined): string | null {
  if (!bundleId) return null;
  const lower = bundleId.toLowerCase();
  const refused = WINDOW_CAPTURE_REFUSED_BUNDLE_IDS.some((id) => {
    const entry = id.toLowerCase();
    return lower === entry || lower.startsWith(`${entry}.`);
  });
  return refused
    ? `${bundleId} holds passwords or login prompts; its windows are never captured or read`
    : null;
}

export interface WindowQuery {
  /** App name or bundle id, case-insensitive; a substring matches when nothing matches exactly. */
  app?: string;
  /** Part of the window title, case-insensitive. */
  window?: string;
}

/**
 * `app` and `window` as the schema sends them. Strict mode sends an
 * omitted one as `null`; blank strings count as omitted.
 */
export function parseWindowQuery(args: Record<string, unknown>): WindowQuery | undefined {
  const app = optionalString(args.app, "app");
  const window = optionalString(args.window, "window");
  if (app === undefined && window === undefined) return undefined;
  return { ...(app === undefined ? {} : { app }), ...(window === undefined ? {} : { window }) };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`\`${name}\` must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The window the query means. The list comes front to back, so the
 * first match is the one the user sees on top. An exact app name or
 * bundle id beats a substring ("Code" must not pick "Xcode" when VS
 * Code's "Code" is open).
 */
export function pickWindow(windows: readonly ScreenWindow[], query: WindowQuery): ScreenWindow | null {
  const title = query.window?.toLowerCase();
  const byTitle = title === undefined ? windows : windows.filter((w) => w.title.toLowerCase().includes(title));
  if (query.app === undefined) return byTitle[0] ?? null;
  const app = query.app.toLowerCase();
  const exact = byTitle.find(
    (w) => w.app?.toLowerCase() === app || w.bundleId?.toLowerCase() === app,
  );
  if (exact) return exact;
  return (
    byTitle.find(
      (w) => (w.app?.toLowerCase().includes(app) ?? false) || (w.bundleId?.toLowerCase().includes(app) ?? false),
    ) ?? null
  );
}

/** One line per window for the model, front to back: `App — title (bundle id)`. */
export function describeWindows(windows: readonly ScreenWindow[], limit = 20): string {
  if (windows.length === 0) return "no app windows are on screen";
  const lines = windows.slice(0, limit).map((w) => `- ${windowLabel(w)}`);
  if (windows.length > limit) lines.push(`- … and ${windows.length - limit} more`);
  return lines.join("\n");
}

export function windowLabel(w: ScreenWindow): string {
  const name = w.app ?? "unknown app";
  const title = w.title ? ` — "${w.title}"` : "";
  const id = w.bundleId ? ` (${w.bundleId})` : "";
  return `${name}${title}${id}`;
}

/** Limits of the Accessibility walk that reads a window's text. */
export const WINDOW_TEXT_LIMITS = { maxDepth: 12, maxElements: 800, maxChars: 20_000 } as const;

/** `screencapture -x -o -t jpg -l <id> <path>`: silent, no shadow, JPEG, that one window. */
export function windowScreencaptureArgs(path: string, windowId: number): string[] {
  return ["-x", "-o", "-t", "jpg", "-l", String(windowId), path];
}
