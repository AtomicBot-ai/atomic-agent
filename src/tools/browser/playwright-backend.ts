import type { ChildProcess } from "node:child_process";
import type {
  BrowserContext as PwBrowserContext,
  Page,
} from "playwright-core";
import type { BrowserChannel } from "../../config/index.js";
import { summariseAriaSnapshot } from "./aria-compressor.js";
import { buildChromeLaunchArgs } from "./build-chrome-launch-args.js";
import {
  decorateChromeProfile,
  markChromeProfileCleanExit,
} from "./decorate-chrome-profile.js";
import { findChromeExecutable } from "./find-chrome-executable.js";
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
  headless: boolean;
  /** Overall budget for "spawn + CDP becomes reachable". */
  launchTimeoutMs: number;
  /** When set, attach to a running browser via CDP instead of launching. */
  cdpUrl?: string | null;
  /** Pass `--no-sandbox`; required in some containerised environments. */
  noSandbox?: boolean;
}

const SEARCH_URLS: Record<NonNullable<SearchInput["engine"]>, string> = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
};

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
 */
export class PlaywrightBackend implements BrowserBackend {
  private context: PwBrowserContext | null = null;
  private spawnedProc: ChildProcess | null = null;
  private spawnedUserDataDir: string | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly options: PlaywrightBackendOptions) {}

  ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initialise();
    }
    return this.ready;
  }

  async shutdown(): Promise<void> {
    if (this.context) {
      const browser = this.context.browser();
      await this.context.close().catch(() => undefined);
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

  async snapshot(options: { depth?: number } = {}): Promise<AriaSnapshot> {
    const page = await this.requireActivePage();
    const bodyLocator = page.locator("body");
    const raw = await bodyLocator.ariaSnapshot({
      mode: "ai",
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    } as never);
    const url = page.url();
    const title = await page.title().catch(() => "");
    const summary = summariseAriaSnapshot(raw, { url, title });
    return {
      url,
      title,
      text: summary.text,
      digest: summary.digest,
      refs: summary.refs,
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
    const base = SEARCH_URLS[input.engine ?? "google"];
    const url = `${base}${encodeURIComponent(input.query)}`;
    await this.navigate({ url });
    return { url };
  }

  async tabs(input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    const context = await this.requireContext();
    const pages = context.pages();
    switch (input.action) {
      case "list":
        return { tabs: await enumerateTabs(pages) };
      case "new": {
        const page = await context.newPage();
        if (input.url) {
          await page.goto(input.url).catch(() => undefined);
        }
        return { tabs: await enumerateTabs(context.pages()) };
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
        return { tabs: await enumerateTabs(context.pages()) };
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
        return { tabs: await enumerateTabs(context.pages()) };
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
    const playwright = await import("playwright-core");
    const cdpUrl = this.options.cdpUrl ?? (await this.launchOwnChrome());
    const browser = await playwright.chromium.connectOverCDP(cdpUrl, {
      timeout: this.options.launchTimeoutMs,
    });
    const contexts = browser.contexts();
    this.context = contexts[0] ?? (await browser.newContext());
  }

  /**
   * Spawn a bare-metal Chrome process with clean flags and wait until
   * its CDP endpoint is reachable. Does NOT connect Playwright — the
   * caller does that step so the same code path serves both
   * "spawn + attach" and "attach to user's browser" modes.
   */
  private async launchOwnChrome(): Promise<string> {
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
    decorateChromeProfile(this.options.userDataDir);
    const cdpPort = await pickAvailableLoopbackPort();
    const args = buildChromeLaunchArgs({
      cdpPort,
      userDataDir: this.options.userDataDir,
      headless: this.options.headless,
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
    return running.cdpUrl;
  }

  private async requireContext(): Promise<PwBrowserContext> {
    await this.ensureReady();
    if (!this.context) {
      throw new Error("browser backend is not initialised");
    }
    return this.context;
  }

  private async requireActivePage(): Promise<Page> {
    const context = await this.requireContext();
    const pages = context.pages();
    const active = pages[pages.length - 1];
    if (active) return active;
    return context.newPage();
  }
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
