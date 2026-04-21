import { mkdir } from "node:fs/promises";
import type {
  BrowserContext as PwBrowserContext,
  Page,
} from "playwright-core";
import { summariseAriaSnapshot } from "./aria-compressor.js";
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
  /** `chrome`, `msedge`, or `chromium`. */
  channel: "chrome" | "msedge" | "chromium";
  headless: boolean;
  launchTimeoutMs: number;
  /** When set, attach to a running browser via CDP instead of launching. */
  cdpUrl?: string | null;
}

const SEARCH_URLS: Record<NonNullable<SearchInput["engine"]>, string> = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
};

/**
 * Playwright-backed implementation. We keep it lazy: the first tool call
 * triggers `ensureReady()`, which either connects to a running browser via
 * CDP or launches a persistent context over the user's installed
 * Chrome/Edge. We deliberately avoid downloading any browser binaries.
 */
export class PlaywrightBackend implements BrowserBackend {
  private context: PwBrowserContext | null = null;
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
      await this.context.close().catch(() => undefined);
      this.context = null;
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
    if (this.options.cdpUrl) {
      const browser = await playwright.chromium.connectOverCDP(
        this.options.cdpUrl,
        { timeout: this.options.launchTimeoutMs },
      );
      const contexts = browser.contexts();
      this.context = contexts[0] ?? (await browser.newContext());
      return;
    }
    await mkdir(this.options.userDataDir, { recursive: true });
    this.context = await playwright.chromium.launchPersistentContext(
      this.options.userDataDir,
      {
        channel: this.options.channel,
        headless: this.options.headless,
        timeout: this.options.launchTimeoutMs,
      },
    );
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
