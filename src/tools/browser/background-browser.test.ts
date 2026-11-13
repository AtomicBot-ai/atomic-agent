import { describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { PlaywrightBackend, type PlaywrightBackendOptions } from "./playwright-backend.js";
import { runInBrowserScope, type BrowserRunScope } from "./browser-run-scope.js";
import { buildBrowserTabsTool } from "./tabs.js";
import { GATE_CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";

/**
 * ATO-959: headless Chrome for turns nobody watches, a window for the
 * ones someone does, and a throwaway logged-out profile per chat.
 */

class FakePage {
  closed = false;
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
  on() {
    return this;
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
  closed = false;
  contexts() {
    return [this.main];
  }
  async newContext() {
    const context = new FakeContext(this);
    this.extra.push(context);
    return context;
  }
  isConnected() {
    return !this.closed;
  }
  async close() {
    this.closed = true;
  }
}

function backendWith(options: Partial<PlaywrightBackendOptions> = {}) {
  const launches: boolean[] = [];
  const browsers: FakeBrowser[] = [];
  const backend = new PlaywrightBackend({
    userDataDir: "/unused",
    channel: "chrome",
    headless: "auto",
    launchTimeoutMs: 1_000,
    launchChrome: async ({ headless }) => {
      launches.push(headless);
      return `ws://127.0.0.1:${9000 + launches.length}/devtools/browser/x`;
    },
    connectOverCdp: async () => {
      const browser = new FakeBrowser();
      browsers.push(browser);
      return browser as unknown as Browser;
    },
    ...options,
  });
  return { backend, launches, browsers };
}

const CRON: BrowserRunScope = { sessionId: "cron-1", attended: false };
const CHAT: BrowserRunScope = { sessionId: "chat-1", attended: true };
const inTurn = <T>(scope: BrowserRunScope, fn: () => Promise<T>) => runInBrowserScope(scope, fn);

describe("headless: auto", () => {
  it("a cron task starts Chrome without a window, a watched chat with one", async () => {
    const cron = backendWith();
    await inTurn(CRON, () => cron.backend.currentUrl());
    expect(cron.launches).toEqual([true]);

    const chat = backendWith();
    await inTurn(CHAT, () => chat.backend.currentUrl());
    expect(chat.launches).toEqual([false]);
  });

  it("a watched chat reopens a headless Chrome with a window and its pages", async () => {
    const { backend, launches, browsers } = backendWith();
    await inTurn(CRON, () => backend.navigate({ url: "https://news.example/today" }));
    await inTurn(CHAT, () => backend.currentUrl());
    expect(launches).toEqual([true, false]);
    expect(browsers[0]!.closed).toBe(true);
    expect(browsers[1]!.main.pages().map((page) => page.url())).toContain("https://news.example/today");
    // Once there is a window, nothing restarts again, for anyone.
    await inTurn(CRON, () => backend.currentUrl());
    await inTurn(CHAT, () => backend.currentUrl());
    expect(launches).toEqual([true, false]);
  });

  it("a background turn uses a window that is already open instead of starting another Chrome", async () => {
    const { backend, launches } = backendWith();
    await inTurn(CHAT, () => backend.currentUrl());
    await inTurn(CRON, () => backend.currentUrl());
    expect(launches).toEqual([false]);
  });

  it("an explicit setting always wins", async () => {
    const always = backendWith({ headless: true });
    await inTurn(CHAT, () => always.backend.currentUrl());
    expect(always.launches).toEqual([true]);
    const never = backendWith({ headless: false });
    await inTurn(CRON, () => never.backend.currentUrl());
    expect(never.launches).toEqual([false]);
  });

  it("a Chrome the agent did not start is never restarted", async () => {
    const { backend, launches, browsers } = backendWith({ cdpUrl: "http://127.0.0.1:9222" });
    await inTurn(CRON, () => backend.currentUrl());
    await inTurn(CHAT, () => backend.currentUrl());
    expect(launches).toEqual([]);
    expect(browsers).toHaveLength(1);
  });
});

describe("throwaway logged-out profile", () => {
  it("tabs new with profile temp opens a separate context, profile agent goes back", async () => {
    const { backend, browsers } = backendWith();
    await inTurn(CHAT, () => backend.navigate({ url: "https://mail.example/inbox" }));
    await inTurn(CHAT, () => backend.tabs({ action: "new", url: "https://shop.example", profile: "temp" }));
    const browser = browsers[0]!;
    expect(browser.extra).toHaveLength(1);
    expect(browser.extra[0]!.pages().map((page) => page.url())).toEqual(["https://shop.example"]);
    // The chat now lives in the throwaway profile: it never sees the agent's tabs.
    const listed = await inTurn(CHAT, () => backend.tabs({ action: "list" }));
    expect(listed.tabs.map((tab) => tab.url)).toEqual(["https://shop.example"]);
    expect(await inTurn(CHAT, () => backend.currentUrl())).toBe("https://shop.example");
    // Another chat is still in the agent's profile.
    expect(await inTurn({ sessionId: "chat-2", attended: true }, () => backend.currentUrl())).toBe(
      "https://mail.example/inbox",
    );
    await inTurn(CHAT, () => backend.tabs({ action: "new", profile: "agent" }));
    const back = await inTurn(CHAT, () => backend.tabs({ action: "list" }));
    expect(back.tabs.map((tab) => tab.url)).toContain("https://mail.example/inbox");
  });

  it("browser.profile temp gives every chat its own profile, closed with its last tab", async () => {
    const { backend, browsers } = backendWith({ profile: "temp" });
    await inTurn(CHAT, () => backend.navigate({ url: "https://a.example" }));
    await inTurn(CRON, () => backend.navigate({ url: "https://b.example" }));
    const browser = browsers[0]!;
    expect(browser.extra).toHaveLength(2);
    expect(browser.main.pages()).toHaveLength(0);
    await inTurn(CHAT, () => backend.tabs({ action: "close", index: 0 }));
    expect(browser.extra[0]!.closed).toBe(true);
    expect(browser.extra[1]!.closed).toBe(false);
  });

  it("keeps at most four throwaway profiles open, closing the oldest", async () => {
    const { backend, browsers } = backendWith({ profile: "temp" });
    for (let i = 0; i < 5; i += 1) {
      await inTurn({ sessionId: `s${i}`, attended: true }, () => backend.currentUrl());
    }
    const contexts = browsers[0]!.extra;
    expect(contexts).toHaveLength(5);
    expect(contexts.map((context) => context.closed)).toEqual([true, false, false, false, false]);
  });

  it("is refused in the user's own Chrome", async () => {
    const { backend } = backendWith({ connect: "user-chrome" });
    await expect(inTurn(CHAT, () => backend.tabs({ action: "new", profile: "temp" }))).rejects.toThrow(
      /only in the agent's own browser/,
    );
  });

  it("browser.tabs takes profile only with action new", async () => {
    const { options } = recordingGate(true);
    const tool = buildBrowserTabsTool(new GateBackend(), options);
    await expect(tool.run({ action: "list", profile: "temp" }, GATE_CTX)).rejects.toThrow(/only with action new/);
    await expect(tool.run({ action: "new", profile: "incognito" }, GATE_CTX)).rejects.toThrow(/"agent" or "temp"/);
    expect((await tool.run({ action: "new", profile: "temp" }, GATE_CTX)).status).toBe("ok");
  });
});
