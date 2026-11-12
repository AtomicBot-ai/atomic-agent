import { describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { PlaywrightBackend, type PlaywrightBackendOptions } from "./playwright-backend.js";
import { endBrowserWorker, runInBrowserScope, type BrowserRunScope } from "./browser-run-scope.js";
import { BrowserTabLimitError } from "./worker-tabs.js";

/** ATO-961: a tab of its own per fusion worker, optional contexts, a tab cap. */

class FakePage {
  closed = false;
  private readonly popupHandlers: Array<(page: FakePage) => void> = [];
  constructor(public href = "about:blank") {}
  url() {
    return this.href;
  }
  async title() {
    return this.href;
  }
  isClosed() {
    return this.closed;
  }
  on(event: string, fn: (page: FakePage) => void) {
    if (event === "popup") this.popupHandlers.push(fn);
    return this;
  }
  /** The page opened a pop-up: it joins the context, like Chrome does. */
  openPopup(context: FakeContext, url: string) {
    const popup = new FakePage(url);
    context.all.push(popup);
    for (const fn of this.popupHandlers) fn(popup);
    return popup;
  }
  async goto(url: string) {
    this.href = url;
  }
  async close() {
    this.closed = true;
  }
  async bringToFront() {}
  frames() {
    return [];
  }
}

class FakeContext {
  closed = false;
  readonly all: FakePage[] = [];
  constructor(private readonly owner: FakeBrowser) {}
  pages() {
    return this.all.filter((page) => !page.closed);
  }
  async newPage() {
    const page = new FakePage();
    this.all.push(page);
    return page;
  }
  async close() {
    this.closed = true;
    for (const page of this.all) page.closed = true;
  }
  browser() {
    return this.owner as unknown as Browser;
  }
}

class FakeBrowser {
  readonly main = new FakeContext(this);
  readonly extra: FakeContext[] = [];
  contexts() {
    return [this.main];
  }
  async newContext() {
    const context = new FakeContext(this);
    this.extra.push(context);
    return context;
  }
  isConnected() {
    return true;
  }
  async close() {}
}

function backendWith(options: Partial<PlaywrightBackendOptions> = {}) {
  const browser = new FakeBrowser();
  const backend = new PlaywrightBackend({
    userDataDir: "/unused",
    channel: "chrome",
    headless: false,
    launchTimeoutMs: 1_000,
    cdpUrl: "http://127.0.0.1:9222",
    connectOverCdp: async () => browser as unknown as Browser,
    ...options,
  });
  return { backend, browser };
}

const CHAT: BrowserRunScope = { sessionId: "chat", attended: true };
const worker = (id: string): BrowserRunScope => ({ sessionId: id, attended: true, workerOf: "chat" });
const inTurn = <T>(scope: BrowserRunScope, fn: () => Promise<T>) => runInBrowserScope(scope, fn);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a tab of its own per fusion worker", () => {
  it("workers in parallel each browse in their own tab, unseen by each other and by the chat", async () => {
    const { backend, browser } = backendWith();
    await inTurn(CHAT, () => backend.navigate({ url: "https://mail.example" }));
    await Promise.all(
      ["w1", "w2", "w3"].map((id) =>
        inTurn(worker(id), () => backend.navigate({ url: `https://shop-${id}.example` })),
      ),
    );
    expect(browser.main.pages()).toHaveLength(4);
    for (const id of ["w1", "w2", "w3"]) {
      const listed = await inTurn(worker(id), () => backend.tabs({ action: "list" }));
      expect(listed.tabs.map((tab) => tab.url)).toEqual([`https://shop-${id}.example`]);
      expect(await inTurn(worker(id), () => backend.currentUrl())).toBe(`https://shop-${id}.example`);
    }
    const chatTabs = await inTurn(CHAT, () => backend.tabs({ action: "list" }));
    expect(chatTabs.tabs.map((tab) => tab.url)).toEqual(["https://mail.example"]);
  });

  it("a worker cannot switch to or close another worker's tab", async () => {
    const { backend, browser } = backendWith();
    await inTurn(worker("w1"), () => backend.navigate({ url: "https://a.example" }));
    await inTurn(worker("w2"), () => backend.navigate({ url: "https://b.example" }));
    await expect(inTurn(worker("w2"), () => backend.tabs({ action: "switch", index: 1 }))).rejects.toThrow(/out of range/);
    await expect(inTurn(worker("w2"), () => backend.tabs({ action: "close", index: 1 }))).rejects.toThrow(/out of range/);
    expect(browser.main.pages().map((page) => page.url())).toEqual(["https://a.example", "https://b.example"]);
  });

  it("a pop-up from a worker's tab stays the worker's", async () => {
    const { backend, browser } = backendWith();
    await inTurn(worker("w1"), () => backend.navigate({ url: "https://shop.example" }));
    const own = browser.main.pages()[0] as unknown as FakePage;
    own.openPopup(browser.main, "https://pay.example");
    expect(await inTurn(worker("w1"), () => backend.currentUrl())).toBe("https://pay.example");
    const chatTabs = await inTurn(CHAT, () => backend.tabs({ action: "list" }));
    expect(chatTabs.tabs.map((tab) => tab.url)).not.toContain("https://pay.example");
  });

  it("a worker's tabs close when its turn ends", async () => {
    const { backend, browser } = backendWith();
    await inTurn(CHAT, () => backend.navigate({ url: "https://mail.example" }));
    await inTurn(worker("w1"), () => backend.navigate({ url: "https://a.example" }));
    endBrowserWorker("w1");
    await settle();
    expect(browser.main.pages().map((page) => page.url())).toEqual(["https://mail.example"]);
  });

  it("workerIsolation context gives each worker its own context, closed at its end", async () => {
    const { backend, browser } = backendWith({ workerIsolation: "context" });
    await inTurn(worker("w1"), () => backend.navigate({ url: "https://a.example" }));
    await inTurn(worker("w2"), () => backend.navigate({ url: "https://b.example" }));
    expect(browser.main.pages()).toHaveLength(0);
    expect(browser.extra.map((context) => context.pages().map((page) => page.url()))).toEqual([
      ["https://a.example"],
      ["https://b.example"],
    ]);
    endBrowserWorker("w1");
    await settle();
    expect(browser.extra.map((context) => context.closed)).toEqual([true, false]);
    // The chat itself stays in the agent's profile.
    await inTurn(CHAT, () => backend.currentUrl());
    expect(browser.main.pages()).toHaveLength(1);
  });
});

describe("browser.maxTabs", () => {
  it("refuses one tab over the limit with a plain error, and frees room when a worker ends", async () => {
    const { backend } = backendWith({ maxTabs: 2 });
    await inTurn(worker("w1"), () => backend.currentUrl());
    await inTurn(worker("w2"), () => backend.currentUrl());
    const over = inTurn(worker("w3"), () => backend.currentUrl());
    await expect(over).rejects.toBeInstanceOf(BrowserTabLimitError);
    await expect(inTurn(CHAT, () => backend.tabs({ action: "new" }))).rejects.toThrow(
      /2 tabs are already open, the limit is 2 \(browser\.maxTabs\)/,
    );
    endBrowserWorker("w1");
    await settle();
    await expect(inTurn(worker("w3"), () => backend.currentUrl())).resolves.toBe("about:blank");
  });

  it("parallel opens cannot slip past the limit together", async () => {
    const { backend, browser } = backendWith({ maxTabs: 3 });
    const results = await Promise.allSettled(
      ["w1", "w2", "w3", "w4", "w5"].map((id) => inTurn(worker(id), () => backend.currentUrl())),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(browser.main.pages()).toHaveLength(3);
  });
});
