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
}

export function buildChromeLaunchArgs(input: BuildChromeLaunchArgsInput): string[] {
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
