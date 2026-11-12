import type { ChildProcess } from "node:child_process";
import type { Browser as PwBrowser, BrowserContext as PwBrowserContext, Page } from "playwright-core";
import type { BrowserChannel, BrowserConnectMode } from "../../config/index.js";
import { loadPlaywrightCore } from "../../native/load-playwright-core.js";
import { summariseAriaSnapshot } from "./aria-compressor.js";
import { describeElementInPage, toRefDescription } from "./describe-element.js";
import { searchUrlFor } from "./search-engines.js";
import { planShot, type CssRect } from "./screenshot-geometry.js";
import { buildChromeLaunchArgs } from "./build-chrome-launch-args.js";
import { clearStaleChromeLocks } from "./clear-stale-chrome-locks.js";
import {
  decorateChromeProfile,
  markChromeProfileCleanExit,
} from "./decorate-chrome-profile.js";
import { findChromeExecutable } from "./find-chrome-executable.js";
import {
  findUserChromeCdpUrl,
  openRemoteDebuggingPage,
  type UserChromeCdpTarget,
} from "./attach-user-chrome.js";
import { UserChromeNotReadyError } from "./user-chrome-endpoint.js";
import {
  currentBrowserScope,
  onBrowserWorkerEnd,
  resolveLaunchHeadless,
  type BrowserHeadlessSetting,
} from "./browser-run-scope.js";
import { TempProfiles, type BrowserProfileChoice } from "./temp-profiles.js";
import {
  BrowserTabLimitError,
  DEFAULT_BROWSER_MAX_TABS,
  MAX_BROWSER_MAX_TABS,
  type BrowserWorkerIsolation,
} from "./worker-tabs.js";
import {
  collectSecretFieldValuesInPage,
  ONE_TIME_CODE_HINT,
  redactSecretFieldValues,
  SECRET_AUTOCOMPLETE_TOKENS,
} from "./redact-secret-fields.js";
import {
  pickAvailableLoopbackPort,
  spawnChrome,
  stopChrome,
} from "./spawn-chrome.js";
import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  RefDescription,
  ScreenshotInput,
  ScreenshotResult,
  ScrollInput,
  ScrollResult,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "./browser-backend.js";

export interface PlaywrightBackendOptions {
  /** Profile directory to persist cookies/logins across runs. */
  userDataDir: string;
  /** Preferred browser family when auto-detecting the executable. */
  channel: BrowserChannel;
  /** Explicit path to a Chromium-family binary; overrides auto-detection. */
  executablePath?: string | null;
  /**
   * `true` / `false`: always / never headless. `"auto"` (ATO-959): a
   * Chrome started for a turn nobody watches (a cron task, a Telegram or
   * Discord message) is headless; a watched turn gets a window, and a
   * headless Chrome the agent started is reopened with one when a watched
   * turn needs it.
   */
  headless: BrowserHeadlessSetting;
  /**
   * `browser.profile` (default `"agent"`): the profile a session browses
   * in until it picks another with `browser.tabs new` (`temp-profiles.ts`).
   */
  profile?: BrowserProfileChoice;
  /**
   * `browser.workerIsolation` (default `"tabs"`, ATO-961): fusion workers
   * browse in tabs of their own in the agent's profile, or each in its own
   * throwaway context (`"context"`; not in the user's own Chrome).
   */
  workerIsolation?: BrowserWorkerIsolation;
  /** `browser.maxTabs`: tabs the agent may have open at once (default 8). */
  maxTabs?: number;
  /** Overall budget for "spawn + CDP becomes reachable". */
  launchTimeoutMs: number;
  /** When set, attach to a running browser via CDP instead of launching. */
  cdpUrl?: string | null;
  /** Pass `--no-sandbox`; required in some containerised environments. */
  noSandbox?: boolean;
  /**
   * `browser.connect`. `"user-chrome"` attaches to the user's own
   * signed-in Chrome (`cdpUrl` when set, else its DevToolsActivePort)
   * and works only in tabs the agent opened there.
   */
  connect?: BrowserConnectMode;
  /** `browser.userDataDir` for `"user-chrome"`; `null` tries the standard places. */
  userChromeDataDir?: string | null;
  /** Test seam: Playwright's `chromium.connectOverCDP`. */
  connectOverCdp?: (url: string, timeoutMs: number) => Promise<PwBrowser>;
  /** Test seam: where the user's Chrome listens. */
  findUserChrome?: () => Promise<UserChromeCdpTarget>;
  /** Test seam: start the agent's own Chrome and return its CDP address. */
  launchChrome?: (input: { headless: boolean }) => Promise<string>;
}

const TEMP_PROFILE_IN_USER_CHROME =
  'a logged-out profile ("temp") works only in the agent\'s own browser, not in your own Chrome (browser.connect "user-chrome")';

/**
 * How long attaching to the user's Chrome may take: Chrome shows its own
 * "Allow remote debugging?" dialog and waits for the user's click.
 */
const USER_CHROME_CONNECT_TIMEOUT_MS = 60_000;

/**
 * Playwright-backed implementation with "openclaw-style" stealth: we
 * spawn the system Chrome ourselves with a minimal flag set (no
 * `--enable-automation`, no Playwright launcher tweaks) and then attach
 * via `connectOverCDP`. This keeps all high-level Playwright APIs
 * (aria snapshots, locators, etc.) while hiding the automation
 * signature that sites like Cloudflare and DataDome key off of.
 *
 * When the caller provides `cdpUrl`, we simply attach — we never touch
 * a user-managed browser process.
 *
 * In `"user-chrome"` mode the agent is a guest in the user's own browser:
 * it opens its own tab and only ever sees, switches to or closes tabs it
 * opened (and their pop-ups); the user's other tabs never reach a
 * snapshot. Shutdown only disconnects. Cookies, saved passwords and
 * storage are never read: there is no API here for them, and secret
 * field values are masked in every snapshot (`redact-secret-fields.ts`).
 */
export class PlaywrightBackend implements BrowserBackend {
  private context: PwBrowserContext | null = null;
  private spawnedProc: ChildProcess | null = null;
  private spawnedUserDataDir: string | null = null;
  private ready: Promise<void> | null = null;
  /** `"user-chrome"`: the tabs the agent opened, oldest first, active last. */
  private readonly ownedPages = new Set<Page>();
  private userProfile = false;
  private openedRemoteDebugging = false;
  /**
   * The browser went away after an attach (the user quit or restarted
   * Chrome, ATO-1260). The next call attaches afresh; in the user's
   * Chrome it does not open the settings page or wait for the switch.
   */
  private lostConnection = false;
  /** Whether the Chrome the agent started is headless; `null` when it started none. */
  private launchedHeadless: boolean | null = null;
  private relaunching: Promise<void> | null = null;
  /** Per-session throwaway profiles (`browser.profile: "temp"`). */
  private readonly tempProfiles = new TempProfiles();
  /** `workerIsolation: "context"`: a throwaway context per fusion worker. */
  private readonly workerContexts = new TempProfiles(MAX_BROWSER_MAX_TABS);
  /** Fusion worker that opened a tab in the shared context (ATO-961). */
  private readonly pageOwners = new WeakMap<Page, string>();
  /** Tabs being opened right now, counted against `maxTabs`. */
  private pendingTabs = 0;
  private stopWorkerEnd: (() => void) | null = null;

  constructor(private readonly options: PlaywrightBackendOptions) {}

  ensureReady(): Promise<void> {
    if (!this.ready) {
      // A failed start (Chrome not reachable yet) is retried on the next
      // call instead of failing every later call with the same error.
      this.ready = this.initialise().catch((error: unknown) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async shutdown(): Promise<void> {
    this.stopWorkerEnd?.();
    this.stopWorkerEnd = null;
    await this.tempProfiles.closeAll();
    await this.workerContexts.closeAll();
    if (this.context) {
      const browser = this.context.browser();
      // The user's own Chrome: disconnect only, never close their
      // windows or tabs.
      if (!this.userProfile) await this.context.close().catch(() => undefined);
      // `connectOverCDP` produces a `Browser` handle separate from the
      // context; close it too so Playwright tears down its CDP session.
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      this.context = null;
    }
    if (this.spawnedProc) {
      if (this.spawnedUserDataDir) {
        try {
          markChromeProfileCleanExit(this.spawnedUserDataDir);
        } catch {
          // non-fatal: next launch will just show a crash bubble once
        }
      }
      await stopChrome(this.spawnedProc).catch(() => undefined);
      this.spawnedProc = null;
      this.spawnedUserDataDir = null;
    }
    this.ownedPages.clear();
    this.userProfile = false;
    this.launchedHeadless = null;
    this.ready = null;
  }

  async hasRef(ref: string): Promise<boolean> {
    const page = await this.requireActivePage();
    // `count()` resolves immediately without waiting — it just inspects
    // the current DOM for matching `aria-ref=<ref>` attributes. This is
    // exactly what we need: refs are attributes baked in by the previous
    // `ariaSnapshot` call and evaporate on the next navigation.
    const matched = await page.locator(`aria-ref=${ref}`).count();
    return matched > 0;
  }

  async describeRef(ref: string): Promise<RefDescription | null> {
    const page = await this.requireActivePage();
    const locator = page.locator(`aria-ref=${ref}`);
    if ((await locator.count()) === 0) return null;
    // Short timeout: this is a read before the real action, and the
    // gate treats a failure as "could not inspect" (asks), not as safe.
    const raw = await locator.first().evaluate(describeElementInPage, undefined, {
      timeout: 2_000,
    });
    return toRefDescription(raw, page.url());
  }

  async currentUrl(): Promise<string> {
    const page = await this.requireActivePage();
    return page.url();
  }

  async snapshot(options: { depth?: number; full?: boolean } = {}): Promise<AriaSnapshot> {
    const page = await this.requireActivePage();
    const bodyLocator = page.locator("body");
    const raw = await bodyLocator.ariaSnapshot({
      mode: "ai",
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    } as never);
    const url = page.url();
    const title = await page.title().catch(() => "");
    const masked = redactSecretFieldValues(raw, await collectSecretValues(page));
    const summary = summariseAriaSnapshot(masked, { url, title }, options?.full
      ? { maxLines: Number.MAX_SAFE_INTEGER, maxChars: 0, dropNoise: false } : {});
    return {
      url,
      title,
      text: summary.text,
      digest: summary.digest,
      refs: summary.refs,
      frameUrls: page.frames().map((frame) => frame.url()),
    };
  }

  async navigate(
    input: NavigateInput,
  ): Promise<{ url: string; title: string }> {
    const page = await this.requireActivePage();
    await page.goto(input.url, {
      waitUntil: input.waitUntil ?? "domcontentloaded",
      timeout: input.timeoutMs ?? 30_000,
    });
    return { url: page.url(), title: await page.title().catch(() => "") };
  }

  async click(input: ClickInput): Promise<{ clickedRef: string }> {
    const page = await this.requireActivePage();
    const locator = page.locator(`aria-ref=${input.ref}`);
    await locator.click({
      button: input.button ?? "left",
      modifiers: input.modifiers,
    });
    return { clickedRef: input.ref };
  }

  async type(input: TypeInput): Promise<{ typedLength: number }> {
    const page = await this.requireActivePage();
    const locator = page.locator(`aria-ref=${input.ref}`);
    if (input.clearFirst) {
      await locator.fill("");
    }
    await locator.fill(input.text);
    if (input.pressEnter) {
      await locator.press("Enter");
    }
    return { typedLength: input.text.length };
  }

  async search(input: SearchInput): Promise<{ url: string }> {
    const url = searchUrlFor(input.engine ?? "google", input.query);
    await this.navigate({ url });
    return { url };
  }

  async scroll(input: ScrollInput): Promise<ScrollResult> {
    const page = await this.requireActivePage();
    // The body runs in the page, not in Node — we cast `globalThis` to
    // `any` so tsc (which targets Node libs here) does not demand
    // `dom` in its lib list just for this closure.
    const result = await page.evaluate(
      ({ direction, amount }) => {
        const w = globalThis as unknown as {
          innerHeight: number;
          scrollY: number;
          scrollTo: (opts: { top: number }) => void;
          scrollBy: (opts: { top: number }) => void;
          document: { documentElement: { scrollHeight: number } };
        };
        const vh = w.innerHeight || 800;
        let delta = 0;
        if (direction === "top") {
          w.scrollTo({ top: 0 });
        } else if (direction === "bottom") {
          w.scrollTo({ top: w.document.documentElement.scrollHeight });
        } else {
          if (typeof amount === "number") {
            delta = amount;
          } else if (amount === "half") {
            delta = Math.floor(vh / 2);
          } else {
            delta = vh;
          }
          if (direction === "up") delta = -delta;
          w.scrollBy({ top: delta });
        }
        return {
          scrollY: Math.round(w.scrollY),
          scrollHeight: Math.round(w.document.documentElement.scrollHeight),
          viewportHeight: vh,
        };
      },
      {
        direction: input.direction,
        amount: input.amount ?? "page",
      },
    );
    return result;
  }

  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    const page = await this.requireActivePage();
    const framesBefore = page.frames().map((frame) => frame.url());
    if (input.ref) {
      const locator = page.locator(`aria-ref=${input.ref}`).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    }
    const metrics = await page.evaluate(readViewportMetricsInPage);
    let rect: CssRect;
    if (input.ref) {
      const box = await page
        .locator(`aria-ref=${input.ref}`)
        .first()
        .boundingBox({ timeout: 2_000 });
      if (!box) throw new Error(`ref '${input.ref}' is not visible on the page`);
      rect = { x: box.x + metrics.pageX, y: box.y + metrics.pageY, width: box.width, height: box.height };
    } else if (input.fullPage) {
      rect = { x: 0, y: 0, width: metrics.scrollWidth, height: metrics.scrollHeight };
    } else {
      rect = { x: metrics.pageX, y: metrics.pageY, width: metrics.viewportWidth, height: metrics.viewportHeight };
    }
    const plan = planShot(rect, metrics.devicePixelRatio, input.maxSide, input.fullPage === true);
    if (!plan) throw new Error(input.ref ? `ref '${input.ref}' has no visible area` : "the page has no visible area");
    await setSecretFieldMask(page, true);
    let data: string;
    const session = await page.context().newCDPSession(page);
    try {
      const shot = (await session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: input.quality,
        clip: { ...plan.clip, scale: plan.scale },
        captureBeyondViewport: input.fullPage === true,
      })) as { data: string };
      data = shot.data;
    } finally {
      await session.detach().catch(() => undefined);
      await setSecretFieldMask(page, false);
    }
    const framesAfter = page.frames().map((frame) => frame.url());
    return {
      buffer: Buffer.from(data, "base64"),
      width: plan.width,
      height: plan.height,
      mime: "image/jpeg",
      url: page.url(),
      title: await page.title().catch(() => ""),
      frameUrls: Array.from(new Set([...framesBefore, ...framesAfter])),
      clipped: plan.clipped,
    };
  }

  async tabs(input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    const scope = currentBrowserScope();
    if (input.action === "new" && input.profile !== undefined && scope) {
      if (input.profile === "temp" && this.options.connect === "user-chrome") {
        throw new Error(`browser.tabs(new): ${TEMP_PROFILE_IN_USER_CHROME}`);
      }
      this.tempProfiles.choose(scope.sessionId, input.profile);
    }
    const context = await this.callerContext();
    const pages = this.visiblePages(context);
    switch (input.action) {
      case "list":
        return { tabs: await enumerateTabs(pages) };
      case "new": {
        const page = await this.openTab(context);
        if (input.url) {
          await page.goto(input.url).catch(() => undefined);
        }
        return { tabs: await enumerateTabs(this.visiblePages(context)) };
      }
      case "switch": {
        if (input.index === undefined) {
          throw new Error("browser.tabs(switch): `index` is required");
        }
        const target = pages[input.index];
        if (!target) {
          throw new Error(
            `browser.tabs(switch): index ${input.index} out of range`,
          );
        }
        await target.bringToFront();
        if (this.userProfile) {
          // Active = last: move it to the end of the agent's tab list.
          this.ownedPages.delete(target);
          this.ownedPages.add(target);
        }
        return { tabs: await enumerateTabs(this.visiblePages(context)) };
      }
      case "close": {
        if (input.index === undefined) {
          throw new Error("browser.tabs(close): `index` is required");
        }
        const target = pages[input.index];
        if (!target) {
          throw new Error(
            `browser.tabs(close): index ${input.index} out of range`,
          );
        }
        await target.close();
        this.ownedPages.delete(target);
        const left = await enumerateTabs(this.visiblePages(context));
        // The last tab of a throwaway profile takes the profile with it.
        if (scope && left.length === 0) await this.tempProfiles.closeIfEmpty(scope.sessionId);
        return { tabs: left };
      }
      default: {
        const exhaustive: never = input.action;
        throw new Error(
          `browser.tabs: unsupported action ${String(exhaustive)}`,
        );
      }
    }
  }

  private async initialise(): Promise<void> {
    this.stopWorkerEnd ??= onBrowserWorkerEnd((workerId) => {
      void this.closeWorkerTabs(workerId);
    });
    if (this.options.connect === "user-chrome") {
      await this.attachUserChrome();
      return;
    }
    const cdpUrl = this.options.cdpUrl ?? (await this.launchOwnChrome());
    const browser = await this.connectOverCdp(cdpUrl, this.options.launchTimeoutMs);
    const contexts = browser.contexts();
    this.context = contexts[0] ?? (await browser.newContext());
  }

  private async connectOverCdp(url: string, timeoutMs: number): Promise<PwBrowser> {
    if (this.options.connectOverCdp) return this.options.connectOverCdp(url, timeoutMs);
    const playwright = await loadPlaywrightCore();
    return playwright.chromium.connectOverCDP(url, { timeout: timeoutMs });
  }

  private findUserChrome(): Promise<UserChromeCdpTarget> {
    if (this.options.findUserChrome) return this.options.findUserChrome();
    return findUserChromeCdpUrl({
      cdpUrl: this.options.cdpUrl ?? null,
      userDataDir: this.options.userChromeDataDir ?? null,
      waitMs: USER_CHROME_CONNECT_TIMEOUT_MS,
      reconnect: this.lostConnection,
      openRemoteDebuggingPage: () => {
        // Once per backend: a retry after the user closed the page
        // should not keep popping it back up.
        if (this.openedRemoteDebugging) return true;
        this.openedRemoteDebugging = true;
        return openRemoteDebuggingPage({
          channel: this.options.channel,
          executablePath: this.options.executablePath ?? null,
        });
      },
    });
  }

  /** `"user-chrome"`: attach to the user's browser and open the agent's own tab lazily. */
  private async attachUserChrome(): Promise<void> {
    const target = await this.findUserChrome();
    let browser: PwBrowser;
    try {
      browser = await this.connectOverCdp(
        target.cdpUrl,
        Math.max(this.options.launchTimeoutMs, USER_CHROME_CONNECT_TIMEOUT_MS),
      );
    } catch {
      throw new UserChromeNotReadyError(
        `${target.browser} did not answer at ${target.cdpUrl} (it may be closed, or the "Allow remote debugging" dialog was declined)`,
      );
    }
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new UserChromeNotReadyError(`${target.browser} has no open window`);
    }
    this.userProfile = true;
    this.context = context;
    this.lostConnection = false;
  }

  /** Track a tab the agent opened in the user's Chrome, and its pop-ups. */
  private adopt(page: Page): void {
    if (!this.userProfile) return;
    this.ownedPages.add(page);
    page.on("popup", (popup) => this.adopt(popup));
    page.on("close", () => {
      this.ownedPages.delete(page);
    });
  }

  /**
   * Every tab, or in the user's Chrome only the agent's own; in the shared
   * context only the caller's: a fusion worker's own tabs, or for anyone
   * else the tabs no worker opened (ATO-961).
   */
  private visiblePages(context: PwBrowserContext): Page[] {
    if (context !== this.context) return context.pages();
    const pages = this.userProfile
      ? [...this.ownedPages].filter((page) => !page.isClosed())
      : context.pages();
    const owner = callerWorkerId();
    return pages.filter((page) => this.pageOwners.get(page) === owner);
  }

  /**
   * Open a tab for the caller in `context`, within `browser.maxTabs`. A
   * worker's tab, and the pop-ups it opens, are named after the worker.
   */
  private async openTab(context: PwBrowserContext): Promise<Page> {
    const max = this.options.maxTabs ?? DEFAULT_BROWSER_MAX_TABS;
    const open = this.openTabCount() + this.pendingTabs;
    if (open >= max) throw new BrowserTabLimitError(open, max);
    this.pendingTabs += 1;
    let page: Page;
    try {
      page = await context.newPage();
    } finally {
      this.pendingTabs -= 1;
    }
    this.adopt(page);
    const owner = callerWorkerId();
    if (owner !== undefined && context === this.context) this.claim(page, owner);
    return page;
  }

  private claim(page: Page, owner: string): void {
    this.pageOwners.set(page, owner);
    page.on("popup", (popup) => this.claim(popup, owner));
  }

  /** Tabs the agent has open: its own (not the user's), throwaway ones, workers'. */
  private openTabCount(): number {
    let count = this.tempProfiles.tabCount() + this.workerContexts.tabCount();
    if (this.context) {
      count += this.userProfile
        ? [...this.ownedPages].filter((page) => !page.isClosed()).length
        : this.context.pages().length;
    }
    return count;
  }

  /** A fusion worker's turn ended: its tabs and context go with it. */
  private async closeWorkerTabs(workerId: string): Promise<void> {
    const pages = this.context?.pages() ?? [];
    await Promise.all(
      pages
        .filter((page) => this.pageOwners.get(page) === workerId)
        .map((page) => page.close().catch(() => undefined)),
    );
    await this.workerContexts.close(workerId);
    await this.tempProfiles.close(workerId);
  }

  /**
   * Spawn a bare-metal Chrome process with clean flags and wait until
   * its CDP endpoint is reachable. Does NOT connect Playwright — the
   * caller does that step so the same code path serves both
   * "spawn + attach" and "attach to user's browser" modes.
   */
  private async launchOwnChrome(): Promise<string> {
    const headless = resolveLaunchHeadless(this.options.headless, currentBrowserScope());
    if (this.options.launchChrome) {
      const cdpUrl = await this.options.launchChrome({ headless });
      this.launchedHeadless = headless;
      return cdpUrl;
    }
    const executable = findChromeExecutable({
      executablePath: this.options.executablePath ?? null,
      channel: this.options.channel,
    });
    if (!executable) {
      throw new Error(
        "Could not find a Chromium-family browser (Chrome, Edge, Brave, or Chromium). " +
          "Install one, or set ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH to the binary path.",
      );
    }
    // Drop locks left by a previous hard kill / SIGINT so Chromium can
    // re-bind the profile (see clear-stale-chrome-locks.ts + #22).
    clearStaleChromeLocks(this.options.userDataDir);
    decorateChromeProfile(this.options.userDataDir);
    const cdpPort = await pickAvailableLoopbackPort();
    const args = buildChromeLaunchArgs({
      cdpPort,
      userDataDir: this.options.userDataDir,
      headless,
      noSandbox: this.options.noSandbox ?? false,
    });
    const running = await spawnChrome({
      executablePath: executable.path,
      args,
      cdpPort,
      userDataDir: this.options.userDataDir,
      readinessTimeoutMs: this.options.launchTimeoutMs,
    });
    this.spawnedProc = running.proc;
    this.spawnedUserDataDir = this.options.userDataDir;
    this.launchedHeadless = headless;
    return running.cdpUrl;
  }

  private async requireContext(): Promise<PwBrowserContext> {
    await this.ensureReady();
    if (this.context && isDisconnected(this.context)) {
      // Chrome was quit or restarted under us: every call on the old
      // handle would fail with "context closed". Drop it and attach
      // again (re-reading `DevToolsActivePort` in the user's Chrome).
      await this.shutdown();
      this.lostConnection = true;
      await this.ensureReady();
    }
    if (this.wantsWindowNow()) await this.relaunchWithWindow();
    if (!this.context) {
      throw new Error("browser backend is not initialised");
    }
    return this.context;
  }

  /**
   * The context the calling session browses in: the agent's profile, or
   * its own throwaway one (`browser.profile` / `browser.tabs new profile`).
   */
  private async callerContext(): Promise<PwBrowserContext> {
    const main = await this.requireContext();
    const scope = currentBrowserScope();
    if (!scope) return main;
    if (this.tempProfiles.choiceFor(scope.sessionId, this.options.profile ?? "agent") === "temp") {
      if (this.userProfile) throw new Error(TEMP_PROFILE_IN_USER_CHROME);
      // Workers draw from their own pool, so parallel workers never push
      // each other's profile out.
      const pool = scope.workerOf !== undefined ? this.workerContexts : this.tempProfiles;
      return pool.open(requireBrowser(main), scope.sessionId);
    }
    // A worker's own context where that is cheap: never in the user's
    // Chrome, where the agent stays in the tabs it opened.
    if (scope.workerOf !== undefined && this.options.workerIsolation === "context" && !this.userProfile) {
      return this.workerContexts.open(requireBrowser(main), scope.sessionId);
    }
    return main;
  }

  /**
   * `headless: "auto"`: the Chrome the agent started is headless (a
   * background turn launched it) and a watched turn now needs it.
   */
  private wantsWindowNow(): boolean {
    return (
      this.options.headless === "auto" &&
      this.launchedHeadless === true &&
      currentBrowserScope()?.attended === true
    );
  }

  /**
   * Restart the agent's own Chrome with a window, reopening the pages it
   * had (throwaway profiles are not carried over). A background turn
   * still using the old pages sees them gone and reads the page again.
   */
  private async relaunchWithWindow(): Promise<void> {
    if (!this.relaunching) {
      this.relaunching = (async () => {
        const urls = (this.context?.pages() ?? [])
          .map((page) => page.url())
          .filter((url) => /^https?:/i.test(url));
        await this.shutdown();
        await this.ensureReady();
        const context = this.context as PwBrowserContext | null;
        if (!context) return;
        for (const url of urls) {
          const page = await context.newPage();
          await page.goto(url).catch(() => undefined);
        }
      })().finally(() => {
        this.relaunching = null;
      });
    }
    await this.relaunching;
  }

  private async requireActivePage(): Promise<Page> {
    const context = await this.callerContext();
    const pages = this.visiblePages(context);
    const active = pages[pages.length - 1];
    if (active) return active;
    return this.openTab(context);
  }
}

/** The calling fusion worker's id (its session), else `undefined`. */
function callerWorkerId(): string | undefined {
  const scope = currentBrowserScope();
  return scope?.workerOf !== undefined ? scope.sessionId : undefined;
}

function requireBrowser(context: PwBrowserContext): PwBrowser {
  const browser = context.browser();
  if (!browser) throw new Error("browser backend has no browser to open a separate context in");
  return browser;
}

/** The CDP connection behind `context` is gone (the browser quit). */
function isDisconnected(context: PwBrowserContext): boolean {
  const browser = context.browser();
  return browser !== null && typeof browser.isConnected === "function" && !browser.isConnected();
}

interface ViewportMetrics {
  devicePixelRatio: number;
  pageX: number;
  pageY: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

/** Runs in the page: scroll offset, viewport and document size in CSS pixels. */
function readViewportMetricsInPage(): ViewportMetrics {
  const w = globalThis as unknown as {
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
    innerWidth: number;
    innerHeight: number;
    visualViewport?: { pageLeft: number; pageTop: number; width: number; height: number } | null;
    document: { documentElement: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number } };
  };
  const vv = w.visualViewport;
  const root = w.document.documentElement;
  return {
    devicePixelRatio: w.devicePixelRatio || 1,
    pageX: vv ? vv.pageLeft : w.scrollX,
    pageY: vv ? vv.pageTop : w.scrollY,
    viewportWidth: vv ? vv.width : root.clientWidth || w.innerWidth,
    viewportHeight: vv ? vv.height : root.clientHeight || w.innerHeight,
    scrollWidth: Math.max(root.scrollWidth, root.clientWidth),
    scrollHeight: Math.max(root.scrollHeight, root.clientHeight),
  };
}

const SECRET_MASK_STYLE_ID = "__atomic_agent_secret_mask";
/** The same secret fields the snapshot masks (`redact-secret-fields.ts`). */
const SECRET_MASK_CSS =
  SECRET_AUTOCOMPLETE_TOKENS.map((token) => `input[autocomplete~="${token}"]`).join(",") +
  "{-webkit-text-security:disc!important}";

/** Runs in each frame: add or remove the style that draws secret fields as dots. */
function toggleSecretMaskInPage(arg: { on: boolean; id: string; css: string }): void {
  const doc = (globalThis as unknown as {
    document: {
      getElementById: (id: string) => { remove: () => void } | null;
      createElement: (tag: string) => { id: string; textContent: string };
      documentElement: { appendChild: (node: unknown) => void };
    };
  }).document;
  doc.getElementById(arg.id)?.remove();
  if (!arg.on) return;
  const style = doc.createElement("style");
  style.id = arg.id;
  style.textContent = arg.css;
  doc.documentElement.appendChild(style);
}

async function setSecretFieldMask(page: Page, on: boolean): Promise<void> {
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(toggleSecretMaskInPage, { on, id: SECRET_MASK_STYLE_ID, css: SECRET_MASK_CSS })
        .catch(() => undefined),
    ),
  );
}

/** Secret field values in every frame; a frame that cannot be read gives none. */
async function collectSecretValues(page: Page): Promise<string[]> {
  const arg = { tokens: [...SECRET_AUTOCOMPLETE_TOKENS], codeHint: ONE_TIME_CODE_HINT };
  const perFrame = await Promise.all(
    page.frames().map((frame) =>
      frame.evaluate(collectSecretFieldValuesInPage, arg).catch(() => [] as string[]),
    ),
  );
  return perFrame.flat();
}

async function enumerateTabs(pages: Page[]): Promise<TabInfo[]> {
  const result: TabInfo[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i]!;
    result.push({
      index: i,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: i === pages.length - 1,
    });
  }
  return result;
}
