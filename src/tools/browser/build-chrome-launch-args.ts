import { HEADLESS_WINDOW_SIZE } from "./web-identity.js";

/**
 * Build the Chrome command-line flags used when atomic-agent spawns a
 * Chromium-family browser itself (rather than attaching to one the user
 * already started).
 *
 * The list is deliberately minimal and mirrors openclaw's approach: we
 * avoid every flag that Playwright/Puppeteer add by default — in
 * particular we do **not** pass `--enable-automation` or
 * `--remote-debugging-pipe`. `--enable-automation` is the single most
 * reliable signal sites use to detect headless-style automation
 * (it flips `navigator.webdriver = true` and surfaces the
 * "Chrome is being controlled by automated test software" infobar).
 *
 * By starting Chrome with only `--remote-debugging-port` we get a plain
 * user-looking browser that still exposes CDP for us to attach to. Most
 * bot-detection heuristics (`navigator.webdriver`, `window.chrome`,
 * client hints) then look identical to a human-started Chrome.
 *
 * Headless uses Chrome's new headless mode (`--headless=new`, the full
 * browser without a window). Left alone it still differs from the real
 * browser in three places, so a headless launch also gets the shared web
 * identity (ATO-969, `web-identity.ts`): the honest User-Agent (new headless
 * says `HeadlessChrome/…`), the system language, and a common laptop window
 * instead of 800x600. A headed launch passes none of these: its own UA,
 * language and window already are the real system's. The timezone is never
 * overridden in either mode.
 */

export interface BuildChromeLaunchArgsInput {
  cdpPort: number;
  userDataDir: string;
  headless: boolean;
  /** Pass when running under Docker/CI without a user namespace. */
  noSandbox?: boolean;
  /** Extra raw flags appended verbatim; caller is responsible for safety. */
  extraArgs?: readonly string[];
  /** Platform override for deterministic tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Headless only: the User-Agent to present (the shared web identity's).
   * Omit when the installed version is unknown, so headless never claims a
   * Chrome version the engine does not have.
   */
  userAgent?: string;
  /** Headless only: UI language, e.g. `ru-RU` (Chrome's `--lang`). */
  lang?: string;
  /** Headless only: window size; defaults to `HEADLESS_WINDOW_SIZE`. */
  windowSize?: { width: number; height: number };
}

export function buildChromeLaunchArgs(
  input: BuildChromeLaunchArgsInput,
): string[] {
  const platform = input.platform ?? process.platform;
  const args: string[] = [
    `--remote-debugging-port=${input.cdpPort}`,
    `--user-data-dir=${input.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];

  if (input.headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
    const size = input.windowSize ?? HEADLESS_WINDOW_SIZE;
    args.push(`--window-size=${size.width},${size.height}`);
    if (input.lang) args.push(`--lang=${input.lang}`);
    if (input.userAgent) args.push(`--user-agent=${input.userAgent}`);
  }
  if (input.noSandbox) {
    args.push("--no-sandbox");
    args.push("--disable-setuid-sandbox");
  }
  if (platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  if (input.extraArgs && input.extraArgs.length > 0) {
    args.push(...input.extraArgs);
  }

  return args;
}
