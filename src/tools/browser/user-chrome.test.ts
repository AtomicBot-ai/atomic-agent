import { describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { GATE_CTX, GateBackend, facts, recordingGate } from "./browser-gate-test-helpers.js";
import {
  buildBrowserClickTool,
  buildBrowserNavigateTool,
  buildBrowserSearchTool,
  buildBrowserTabsTool,
  buildBrowserTypeTool,
} from "./index.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import { findUserChromeCdpUrl } from "./attach-user-chrome.js";
import { PlaywrightBackend } from "./playwright-backend.js";
import { UserChromeNotReadyError } from "./user-chrome-endpoint.js";
import { redactSecretFieldValues, SECRET_MASK } from "./redact-secret-fields.js";
import { UserSiteApprovals } from "./user-profile-sites.js";
import { buildBrowserReadAriaTool } from "./read-aria.js";

/**
 * `browser.connect: "user-chrome"` (ATO-511): finding the user's Chrome,
 * the stricter gate in their profile, the agent staying in its own tabs,
 * and secret field values never reaching a snapshot.
 */

/** The fake page lives on shop.example; listing it keeps these tests on the action gate. */
const USER: BrowserDomainPolicy = { blockedDomains: [], allowedDomains: ["shop.example"], userProfile: true };

describe("gate in the user's own Chrome", () => {
  it("a submit asks as browser_secret (every time, never granted), then clicks", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "button", name: "Send", isSubmit: true, inForm: true, href: null });
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserClickTool(backend, options, USER).run({ ref: "e1" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: "browser_secret" });
    expect(String(prompts[0]?.reason)).toMatch(/^in your own Chrome: /);
    expect(prompts[0]?.preview).toContain('"Send"');
  });

  it("a denied submit never reaches the browser", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "button", name: "Post", isSubmit: true, inForm: true, href: null });
    const { options } = recordingGate(false);
    await expect(buildBrowserClickTool(backend, options, USER).run({ ref: "e1" }, GATE_CTX))
      .rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(backend.clicks).toHaveLength(0);
  });

  it("Enter in a form asks as browser_secret and keeps the typed text visible", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "text", editable: true, inForm: true, href: null, name: "Comment" });
    const { prompts, options } = recordingGate(true);
    await buildBrowserTypeTool(backend, options, USER).run({ ref: "e1", text: "hello", pressEnter: true }, GATE_CTX);
    expect(prompts[0]).toMatchObject({ category: "browser_secret" });
    expect(prompts[0]?.preview).toContain('"hello"');
  });

  it("a password field still asks and hides the text", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "password", editable: true, href: null, name: "Password" });
    const { prompts, options } = recordingGate(true);
    await buildBrowserTypeTool(backend, options, USER).run({ ref: "e1", text: "hunter22" }, GATE_CTX);
    expect(prompts[0]).toMatchObject({ category: "browser_secret" });
    expect(prompts[0]?.preview).not.toContain("hunter22");
  });

  it("a plain link does not ask", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    const result = await buildBrowserClickTool(backend, options, USER).run({ ref: "e1" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(0);
  });

  it.each([
    "chrome://password-manager/passwords",
    "chrome://settings/cookies",
    "file:///Users/me/Library/Application%20Support/Google/Chrome/Default/Cookies",
    "view-source:https://bank.example",
    "data:text/html,<script>x</script>",
    "chrome-extension://abc/popup.html",
  ])("refuses %s outright, at every level, without asking", async (url) => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    const nav = await buildBrowserNavigateTool(backend, options, USER).run({ url }, GATE_CTX);
    expect(nav.status).toBe("error");
    expect(nav.details).toMatchObject({ reason: "user_profile_nonweb" });
    const tab = await buildBrowserTabsTool(backend, options, USER).run({ action: "new", url }, GATE_CTX);
    expect(tab.status).toBe("error");
    expect(prompts).toHaveLength(0);
    expect(backend.navigations).toHaveLength(0);
    expect(backend.tabCalls).toBe(0);
  });

  it("http(s) pages and search still work", async () => {
    const backend = new GateBackend();
    const { options } = recordingGate(true);
    expect((await buildBrowserNavigateTool(backend, options, USER).run({ url: "https://example.com" }, GATE_CTX)).status).toBe("ok");
    expect((await buildBrowserSearchTool(backend, options, USER).run({ query: "weather" }, GATE_CTX)).status).toBe("ok");
  });
});

describe("sites in the user's own Chrome", () => {
  const sitesPolicy = (): BrowserDomainPolicy => ({
    blockedDomains: [],
    allowedDomains: [],
    userProfile: true,
    userSites: new UserSiteApprovals(),
  });

  it("opening a new site asks once per session as browser_secret, then not again", async () => {
    const policy = sitesPolicy();
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    const nav = buildBrowserNavigateTool(backend, options, policy);
    await nav.run({ url: "https://mail.example/inbox" }, GATE_CTX);
    await nav.run({ url: "https://mail.example/sent" }, GATE_CTX);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: "browser_secret", affectedResources: ["mail.example"] });
    await nav.run({ url: "https://mail.example/" }, { ...GATE_CTX, sessionId: "other" });
    expect(prompts).toHaveLength(2);
  });

  it("a denied site is never opened, and a URL carrying data to a new host asks", async () => {
    const policy = sitesPolicy();
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    await expect(
      buildBrowserNavigateTool(backend, options, policy).run({ url: "https://evil.test/?d=secret" }, GATE_CTX),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts[0]?.preview).toContain("evil.test/?d=secret");
    expect(backend.navigations).toHaveLength(0);
  });

  it("a link to a new host asks before the click", async () => {
    const policy = sitesPolicy();
    policy.userSites!.add(GATE_CTX.sessionId, "shop.example");
    const backend = new GateBackend();
    backend.element = facts({ href: "https://evil.test/collect?x=1" });
    const { prompts, options } = recordingGate(false);
    await expect(buildBrowserClickTool(backend, options, policy).run({ ref: "e1" }, GATE_CTX))
      .rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts[0]).toMatchObject({ category: "browser_secret", affectedResources: ["evil.test"] });
    expect(backend.clicks).toHaveLength(0);
  });

  it("reading a page on a site not cleared asks first; without a gate it is refused", async () => {
    const policy = sitesPolicy();
    const backend = new GateBackend();
    backend.url = "https://console.example/keys";
    const { prompts, options } = recordingGate(false);
    await expect(buildBrowserReadAriaTool(backend, policy, undefined, options).run({}, GATE_CTX))
      .rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts[0]).toMatchObject({ category: "browser_secret" });
    const refused = await buildBrowserReadAriaTool(backend, policy).run({}, GATE_CTX);
    expect(refused.details).toMatchObject({ reason: "user_site_not_cleared" });
  });

  it("compact views go through the same site check", async () => {
    const policy = sitesPolicy();
    const backend = new GateBackend();
    backend.url = "https://console.example/keys";
    const refused = await buildBrowserReadAriaTool(backend, policy).run({ mode: "interactive" }, GATE_CTX);
    expect(refused.details).toMatchObject({ reason: "user_site_not_cleared" });
    expect(JSON.stringify(refused)).not.toContain("secret page text");
    const { prompts, options } = recordingGate(true);
    const asked = await buildBrowserReadAriaTool(backend, policy, undefined, options).run({ mode: "interactive" }, GATE_CTX);
    expect(asked.status).toBe("ok");
    expect(prompts).toHaveLength(1);
  });

  it("the world snapshot is not captured when navigate landed on a site not cleared", async () => {
    const policy = sitesPolicy();
    const backend = new GateBackend();
    backend.redirects.set("https://shop.example/", "https://console.example/keys");
    const { options } = recordingGate(true);
    const result = await buildBrowserNavigateTool(backend, options, policy).run({ url: "https://shop.example/" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(result.details.worldSnapshot).toBeUndefined();
  });

  it("hosts in allowedDomains do not ask", async () => {
    const policy = { ...sitesPolicy(), allowedDomains: ["docs.example"] };
    const { prompts, options } = recordingGate(false);
    const result = await buildBrowserNavigateTool(new GateBackend(), options, policy).run(
      { url: "https://www.docs.example/a" },
      GATE_CTX,
    );
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(0);
  });
});

describe("findUserChromeCdpUrl", () => {
  const notReady = () => {
    throw new UserChromeNotReadyError("remote debugging is not turned on");
  };
  const found = () => ({ wsUrl: "ws://127.0.0.1:9333/devtools/browser/abc", browser: "Google Chrome", userDataDir: "/x" });

  it("uses an explicit address the user started Chrome with, without looking further", async () => {
    let opened = 0;
    const target = await findUserChromeCdpUrl({
      cdpUrl: "http://127.0.0.1:9222",
      userDataDir: null,
      waitMs: 0,
      openRemoteDebuggingPage: () => (opened += 1) > 0,
      resolve: () => {
        throw new Error("must not be called");
      },
    });
    expect(target).toEqual({ cdpUrl: "http://127.0.0.1:9222", browser: "Chrome", openedSettings: false });
    expect(opened).toBe(0);
  });

  it("attaches through DevToolsActivePort when remote debugging is already on", async () => {
    const target = await findUserChromeCdpUrl({
      cdpUrl: null,
      userDataDir: null,
      waitMs: 0,
      openRemoteDebuggingPage: () => {
        throw new Error("must not open");
      },
      resolve: found,
    });
    expect(target.cdpUrl).toBe("ws://127.0.0.1:9333/devtools/browser/abc");
    expect(target.openedSettings).toBe(false);
  });

  it("opens Chrome on the remote-debugging page and waits for the user to turn it on", async () => {
    let calls = 0;
    let opened = 0;
    let clock = 0;
    const target = await findUserChromeCdpUrl({
      cdpUrl: null,
      userDataDir: null,
      waitMs: 10_000,
      pollMs: 1_000,
      openRemoteDebuggingPage: () => {
        opened += 1;
        return true;
      },
      resolve: () => {
        calls += 1;
        return calls < 3 ? notReady() : found();
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(opened).toBe(1);
    expect(target.openedSettings).toBe(true);
  });

  it("gives plain steps when the user does not turn it on in time", async () => {
    let clock = 0;
    await expect(
      findUserChromeCdpUrl({
        cdpUrl: null,
        userDataDir: null,
        waitMs: 3_000,
        openRemoteDebuggingPage: () => true,
        resolve: notReady,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
    ).rejects.toThrow(/Could not reach your Chrome: .*chrome:\/\/inspect\/#remote-debugging/);
  });

  it("says so when no Chromium-family browser is installed", async () => {
    await expect(
      findUserChromeCdpUrl({ cdpUrl: null, userDataDir: null, waitMs: 1_000, openRemoteDebuggingPage: () => false, resolve: notReady }),
    ).rejects.toThrow(/no Chrome, Chromium, Brave or Edge is installed/);
  });
});

/** A minimal Playwright page / context / browser for the backend's own logic. */
class FakePage {
  closed = false;
  handlers = new Map<string, Array<(arg: unknown) => void>>();
  constructor(public href: string, public secrets: string[] = [], public aria = "") {}
  url() {
    return this.href;
  }
  async title() {
    return this.href;
  }
  isClosed() {
    return this.closed;
  }
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, arg?: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
  async goto(url: string) {
    this.href = url;
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
  async bringToFront() {}
  frames() {
    return [{ url: () => this.href, evaluate: async () => this.secrets }];
  }
  locator() {
    return { ariaSnapshot: async () => this.aria, count: async () => 0 };
  }
}

class FakeContext {
  closedCalls = 0;
  constructor(public all: FakePage[]) {}
  pages() {
    return this.all.filter((p) => !p.closed);
  }
  async newPage() {
    const page = new FakePage("about:blank");
    this.all.push(page);
    return page;
  }
  async close() {
    this.closedCalls += 1;
  }
}

function fakeBrowser(context: FakeContext | null) {
  const state = { closed: 0 };
  const browser = {
    contexts: () => (context ? [context] : []),
    close: async () => {
      state.closed += 1;
    },
  };
  if (context) (context as unknown as { browser: () => unknown }).browser = () => browser;
  return { browser: browser as unknown as Browser, state };
}

function userChromeBackend(context: FakeContext | null, connect?: () => Promise<Browser>) {
  const { browser, state } = fakeBrowser(context);
  const backend = new PlaywrightBackend({
    userDataDir: "/unused",
    channel: "chrome",
    headless: false,
    launchTimeoutMs: 1_000,
    connect: "user-chrome",
    findUserChrome: async () => ({ cdpUrl: "ws://127.0.0.1:9333/devtools/browser/abc", browser: "Google Chrome", openedSettings: false }),
    connectOverCdp: connect ?? (async () => browser),
  });
  return { backend, state };
}

describe("PlaywrightBackend in the user's own Chrome", () => {
  it("never sees, switches to or closes the user's own tabs", async () => {
    const bank = new FakePage("https://bank.example/accounts");
    const mail = new FakePage("https://mail.example/inbox");
    const context = new FakeContext([bank, mail]);
    const { backend } = userChromeBackend(context);

    expect((await backend.tabs({ action: "list" })).tabs).toEqual([]);
    expect(await backend.currentUrl()).toBe("about:blank");
    const listed = (await backend.tabs({ action: "list" })).tabs;
    expect(listed).toHaveLength(1);
    expect(listed.map((t) => t.url)).not.toContain(bank.href);
    await expect(backend.tabs({ action: "switch", index: 1 })).rejects.toThrow(/out of range/);
    await expect(backend.tabs({ action: "close", index: 1 })).rejects.toThrow(/out of range/);
    expect(bank.closed).toBe(false);
    expect(mail.closed).toBe(false);
  });

  it("follows pop-ups the agent's tab opens, and forgets closed tabs", async () => {
    const context = new FakeContext([new FakePage("https://bank.example")]);
    const { backend } = userChromeBackend(context);
    await backend.tabs({ action: "new", url: "https://shop.example" });
    const own = context.all[context.all.length - 1]!;
    const popup = new FakePage("https://pay.example/window");
    own.emit("popup", popup);
    expect(await backend.currentUrl()).toBe("https://pay.example/window");
    await popup.close();
    expect(await backend.currentUrl()).toBe("https://shop.example");
  });

  it("shutdown disconnects without closing the user's browser", async () => {
    const context = new FakeContext([new FakePage("https://bank.example")]);
    const { backend, state } = userChromeBackend(context);
    await backend.ensureReady();
    await backend.shutdown();
    expect(context.closedCalls).toBe(0);
    expect(state.closed).toBe(1);
  });

  it("a Chrome that does not answer is a plain error, and the next call retries", async () => {
    const context = new FakeContext([]);
    const { browser } = fakeBrowser(context);
    let attempts = 0;
    const { backend } = userChromeBackend(context, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      return browser;
    });
    await expect(backend.ensureReady()).rejects.toThrow(
      /Could not reach your Chrome: Google Chrome did not answer .*Allow remote debugging/,
    );
    await expect(backend.ensureReady()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("masks password values in the snapshot", async () => {
    const context = new FakeContext([]);
    const { backend } = userChromeBackend(context);
    await backend.ensureReady();
    await backend.tabs({ action: "new" });
    const page = context.all[0]!;
    page.secrets = ["s3cret-Pass!"];
    page.aria = '- textbox "Email" [ref=e1]: me@example.com\n- textbox "Password" [ref=e2]: s3cret-Pass!\n- button "Sign in" [ref=e3]';
    const snap = await backend.snapshot({ full: true });
    expect(snap.text).not.toContain("s3cret-Pass!");
    expect(snap.text).toContain(SECRET_MASK);
    expect(snap.text).toContain("me@example.com");
  });
});

describe("redactSecretFieldValues", () => {
  it("masks a short value only at a field's line end, a long one everywhere", () => {
    const text = '- textbox "PIN" [ref=e1]: 1234\n- text: order 1234\n- textbox "Password" [ref=e2]: "a: b"\n- text: echo longsecret';
    const out = redactSecretFieldValues(text, ["1234", "a: b", "longsecret"]);
    expect(out).toContain(`[ref=e1]: ${SECRET_MASK}`);
    expect(out).toContain("order 1234");
    expect(out).toContain(`[ref=e2]: ${SECRET_MASK}`);
    expect(out).not.toContain("longsecret");
  });

  it("leaves text alone when there are no secrets", () => {
    expect(redactSecretFieldValues("- textbox [ref=e1]: hi", [])).toBe("- textbox [ref=e1]: hi");
  });
});
