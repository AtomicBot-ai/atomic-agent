import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { GATE_CTX, GateBackend } from "./browser-gate-test-helpers.js";
import { UserSiteApprovals } from "./user-profile-sites.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import { buildBrowserDebugTool, DEBUG_DEFAULT_LIMIT } from "./debug.js";
import { PageDebugLog } from "./page-debug-log.js";
import { watchPageDebugEvents } from "./watch-page-debug.js";

/** `browser.debug` (ATO-701): console and network lists of the agent's pages. */

class DebugBackend extends GateBackend {
  readonly log = new PageDebugLog(() => Date.UTC(2026, 10, 12, 10, 0, 0));
  debugLog(): PageDebugLog {
    return this.log;
  }
}

describe("browser.debug", () => {
  it("lists console messages and page errors, newest last", async () => {
    const backend = new DebugBackend();
    backend.log.addConsole({ level: "log", text: "app started", pageUrl: "https://app.example/" });
    backend.log.addConsole({ level: "error", text: "Failed to load config", source: "https://app.example/main.js:10", pageUrl: "https://app.example/" });
    const result = await buildBrowserDebugTool(backend).run({ action: "console" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("console: 2 of 2 console messages");
    expect(result.summary).toContain("[10:00:00] error     Failed to load config  (https://app.example/main.js:10)");
    expect(result.summary.indexOf("app started")).toBeLessThan(result.summary.indexOf("Failed to load config"));
    const errors = await buildBrowserDebugTool(backend).run({ action: "console", errorsOnly: true }, GATE_CTX);
    expect(errors.summary).not.toContain("app started");
    expect(errors.details).toMatchObject({ count: 1, errorsOnly: true });
  });

  it("lists requests with status and failures, and counts the failed ones", async () => {
    const backend = new DebugBackend();
    backend.log.addResponse({ method: "GET", url: "https://app.example/", resourceType: "document", status: 200, pageUrl: "https://app.example/" });
    backend.log.addResponse({ method: "GET", url: "https://app.example/api/me", resourceType: "fetch", status: 401, pageUrl: "https://app.example/" });
    backend.log.addFailure({ method: "GET", url: "https://cdn.example/app.js", resourceType: "script", failure: "net::ERR_NAME_NOT_RESOLVED", pageUrl: "https://app.example/" });
    const tool = buildBrowserDebugTool(backend);
    const all = await tool.run({ action: "network" }, GATE_CTX);
    expect(all.summary).toContain("failed: 2");
    expect(all.summary).toContain("GET 401 fetch https://app.example/api/me");
    expect(all.summary).toContain("GET failed net::ERR_NAME_NOT_RESOLVED script https://cdn.example/app.js");
    const failed = await tool.run({ action: "network", errorsOnly: true }, GATE_CTX);
    expect(failed.details).toMatchObject({ count: 2 });
    expect(failed.summary).not.toContain("document");
  });

  it("honours limit and clear", async () => {
    const backend = new DebugBackend();
    for (let i = 0; i < DEBUG_DEFAULT_LIMIT + 10; i += 1) {
      backend.log.addConsole({ level: "log", text: `line ${i}`, pageUrl: "https://app.example/" });
    }
    const tool = buildBrowserDebugTool(backend);
    const byDefault = await tool.run({ action: "console" }, GATE_CTX);
    expect(byDefault.details).toMatchObject({ count: DEBUG_DEFAULT_LIMIT, total: DEBUG_DEFAULT_LIMIT + 10 });
    expect(byDefault.summary).not.toContain("line 9\n");
    const three = await tool.run({ action: "console", limit: 3, clear: true }, GATE_CTX);
    expect(three.details).toMatchObject({ count: 3 });
    expect(three.summary).toContain("line 59");
    expect(three.summary).toContain("list cleared");
    const after = await tool.run({ action: "console" }, GATE_CTX);
    expect(after.details).toMatchObject({ count: 0 });
  });

  it("leaves out entries from blocked hosts and, in the user's Chrome, from sites not opened this session", async () => {
    const backend = new DebugBackend();
    backend.log.addConsole({ level: "error", text: "bank error", pageUrl: "https://bank.example/home" });
    backend.log.addConsole({ level: "error", text: "mail error", pageUrl: "https://mail.example/inbox" });
    backend.log.addConsole({ level: "error", text: "shop error", pageUrl: "https://shop.example/" });
    const sites = new UserSiteApprovals();
    sites.add(GATE_CTX.sessionId, "shop.example");
    const policy: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [], userProfile: true, userSites: sites };
    const result = await buildBrowserDebugTool(backend, policy).run({ action: "console" }, GATE_CTX);
    expect(result.summary).toContain("shop error");
    expect(result.summary).not.toContain("bank error");
    expect(result.summary).not.toContain("mail error");
    expect(result.details).toMatchObject({ hidden: 2, count: 1 });
  });

  it("rejects bad arguments, and says so on a backend that records nothing", async () => {
    const tool = buildBrowserDebugTool(new DebugBackend());
    expect((await tool.run({}, GATE_CTX)).details).toMatchObject({ reason: "bad_action" });
    expect((await tool.run({ action: "performance" }, GATE_CTX)).details).toMatchObject({ reason: "bad_action" });
    expect((await tool.run({ action: "console", limit: "5" }, GATE_CTX)).details).toMatchObject({ reason: "bad_args" });
    expect((await tool.run({ action: "console", clear: "yes" }, GATE_CTX)).details).toMatchObject({ reason: "bad_args" });
    const plain = await buildBrowserDebugTool(new GateBackend()).run({ action: "console" }, GATE_CTX);
    expect(plain.details).toMatchObject({ reason: "unsupported" });
  });
});

/** A context that hands registered listeners back so a test can fire Playwright-shaped events. */
class FakeEventContext {
  readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, arg: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
}

function fakePage(url: string): Page {
  return { url: () => url } as unknown as Page;
}

function request(page: Page | null, url: string, failure?: string) {
  return {
    method: () => "GET",
    url: () => url,
    resourceType: () => "fetch",
    failure: () => (failure ? { errorText: failure } : null),
    frame: () => {
      if (page === null) throw new Error("service worker request has no frame");
      return { page: () => page };
    },
  };
}

describe("watchPageDebugEvents", () => {
  it("records console, page errors, responses and failures of visible pages only", () => {
    const context = new FakeEventContext();
    const log = new PageDebugLog(() => 0);
    const mine = fakePage("https://app.example/");
    const theirs = fakePage("https://private.example/");
    watchPageDebugEvents(context as never, log, (page) => page === mine);

    const consoleMessage = (page: Page, text: string) => ({
      page: () => page,
      type: () => "error",
      text: () => text,
      location: () => ({ url: "https://app.example/a.js", lineNumber: 4, columnNumber: 0 }),
    });
    context.emit("console", consoleMessage(mine, "mine"));
    context.emit("console", consoleMessage(theirs, "theirs"));
    const error = new TypeError("x is undefined");
    error.stack = "TypeError: x is undefined\n    at main (https://app.example/a.js:9:3)";
    context.emit("weberror", { page: () => mine, error: () => error });
    context.emit("response", { url: () => "https://app.example/api", status: () => 500, request: () => request(mine, "https://app.example/api") });
    context.emit("response", { url: () => "https://private.example/x", status: () => 200, request: () => request(theirs, "https://private.example/x") });
    context.emit("requestfailed", request(mine, "https://cdn.example/lib.js", "net::ERR_FAILED"));
    context.emit("requestfailed", request(null, "https://app.example/sw.js", "net::ERR_FAILED"));

    expect(log.console(false).map((entry) => entry.text)).toEqual([
      "mine",
      "TypeError: x is undefined (at main (https://app.example/a.js:9:3))",
    ]);
    expect(log.console(false)[0]).toMatchObject({ source: "https://app.example/a.js:5", level: "error" });
    expect(log.network(false)).toEqual([
      expect.objectContaining({ url: "https://app.example/api", status: 500 }),
      expect.objectContaining({ url: "https://cdn.example/lib.js", failure: "net::ERR_FAILED" }),
    ]);
  });

  it("never throws into Playwright when an event cannot be read", () => {
    const context = new FakeEventContext();
    const log = new PageDebugLog(() => 0);
    watchPageDebugEvents(context as never, log, () => true);
    expect(() => context.emit("console", { page: () => { throw new Error("closed"); } })).not.toThrow();
    expect(log.console(false)).toEqual([]);
  });
});
