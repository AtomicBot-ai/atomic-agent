import { describe, expect, it } from "vitest";
import { PageDebugLog, redactDebugText, redactDebugUrl, RING_ALL, RING_ERRORS } from "./page-debug-log.js";

/** The bounded, redacted record behind `browser.debug` (ATO-701). */

describe("redactDebugUrl", () => {
  it("drops user info and masks secret query values and parameter fragments", () => {
    const out = redactDebugUrl("https://bob:hunter2@api.example/v1/items?page=2&api_key=sk-abc123XYZ&code=4/0Ab&sig=deadbeef#access_token=ya29.x");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-abc123XYZ");
    expect(out).not.toContain("4/0Ab");
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("ya29");
    expect(out).toContain("page=2");
    expect(out).toContain("api_key=[redacted:secret]");
    expect(out.startsWith("https://api.example/v1/items?")).toBe(true);
  });

  it("leaves an ordinary URL readable and shortens data: URLs", () => {
    expect(redactDebugUrl("https://shop.example/cart?item=42")).toBe("https://shop.example/cart?item=42");
    expect(redactDebugUrl("data:image/png;base64,AAAA")).toBe("data:…");
  });

  it("caps the length", () => {
    expect(redactDebugUrl(`https://a.example/${"x".repeat(1_000)}`).length).toBeLessThanOrEqual(300);
  });
});

describe("redactDebugText", () => {
  it("masks a bearer token a page logged and clips long text", () => {
    const out = redactDebugText("fetch failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redactDebugText("y".repeat(2_000)).length).toBeLessThanOrEqual(500);
  });
});

describe("PageDebugLog", () => {
  it("keeps errors in a ring of their own so traffic does not push them out", () => {
    const log = new PageDebugLog(() => 0);
    log.addFailure({ method: "post", url: "https://api.example/save", resourceType: "fetch", failure: "net::ERR_CONNECTION_REFUSED", pageUrl: "https://app.example/" });
    for (let i = 0; i < RING_ALL + 5; i += 1) {
      log.addResponse({ method: "GET", url: `https://cdn.example/${i}.png`, resourceType: "image", status: 200, pageUrl: "https://app.example/" });
    }
    expect(log.network(false)).toHaveLength(RING_ALL);
    expect(log.network(false).some((entry) => entry.failure !== undefined)).toBe(false);
    expect(log.network(true)).toEqual([
      expect.objectContaining({ method: "POST", failure: "net::ERR_CONNECTION_REFUSED", url: "https://api.example/save" }),
    ]);
  });

  it("counts HTTP 4xx/5xx as failed, and console errors and page errors as errors", () => {
    const log = new PageDebugLog(() => 0);
    log.addResponse({ method: "GET", url: "https://app.example/api", resourceType: "xhr", status: 404, pageUrl: "https://app.example/" });
    log.addResponse({ method: "GET", url: "https://app.example/ok", resourceType: "xhr", status: 304, pageUrl: "https://app.example/" });
    expect(log.network(true).map((entry) => entry.status)).toEqual([404]);
    log.addConsole({ level: "log", text: "hello", pageUrl: "https://app.example/" });
    log.addConsole({ level: "warn", text: "careful", pageUrl: "https://app.example/" });
    log.addConsole({ level: "error", text: "boom", pageUrl: "https://app.example/" });
    log.addConsole({ level: "pageerror", text: "TypeError: x is undefined", pageUrl: "https://app.example/" });
    expect(log.console(false).map((entry) => entry.level)).toEqual(["log", "warning", "error", "pageerror"]);
    expect(log.console(true).map((entry) => entry.text)).toEqual(["boom", "TypeError: x is undefined"]);
  });

  it("caps the error ring and clears one kind at a time", () => {
    const log = new PageDebugLog(() => 0);
    for (let i = 0; i < RING_ERRORS + 3; i += 1) log.addConsole({ level: "error", text: `e${i}`, pageUrl: "https://a.example/" });
    log.addResponse({ method: "GET", url: "https://a.example/", resourceType: "document", status: 500, pageUrl: "https://a.example/" });
    expect(log.console(true)).toHaveLength(RING_ERRORS);
    expect(log.console(true)[0]!.text).toBe("e3");
    log.clear("console");
    expect(log.console(false)).toEqual([]);
    expect(log.network(true)).toHaveLength(1);
  });
});
