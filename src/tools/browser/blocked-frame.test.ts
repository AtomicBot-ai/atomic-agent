import { describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";
import { buildBrowserNavigateTool, buildBrowserReadAriaTool } from "./index.js";
import { blockedHostOfPage, type BrowserDomainPolicy } from "./browser-domain-policy.js";
import type { AriaSnapshot } from "./browser-backend.js";

/**
 * Playwright's AI-mode snapshot includes iframe content, cross-origin
 * frames too: an allowed page framing a blocked site is refused whole.
 */

const POLICY: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [] };

class FramingBackend extends GateBackend {
  frames = ["https://news.example/", "https://login.bank.example/widget"];
  override async snapshot(): Promise<AriaSnapshot> {
    const snap = await super.snapshot();
    return { ...snap, frameUrls: this.frames };
  }
}

describe("blocked site inside a frame", () => {
  it("blockedHostOfPage checks the page and every frame", () => {
    expect(blockedHostOfPage("https://news.example/", ["https://bank.example/x"], POLICY)).toBe("bank.example");
    expect(blockedHostOfPage("https://news.example/", ["about:blank"], POLICY)).toBeNull();
    expect(blockedHostOfPage("https://bank.example/", undefined, POLICY)).toBe("bank.example");
  });

  it("read_aria refuses the whole page", async () => {
    const backend = new FramingBackend();
    backend.url = "https://news.example/";
    const result = await buildBrowserReadAriaTool(backend, POLICY).run({}, GATE_CTX);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ host: "login.bank.example", reason: "blocked_domain" });
    expect(JSON.stringify(result)).not.toContain("secret page text");
  });

  it("the world snapshot after navigate is not captured", async () => {
    const backend = new FramingBackend();
    const { options } = recordingGate(true);
    const result = await buildBrowserNavigateTool(backend, options, POLICY).run({ url: "https://news.example/" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(result.details.worldSnapshot).toBeUndefined();
  });

  it("a page without blocked frames reads normally", async () => {
    const backend = new FramingBackend();
    backend.frames = ["https://news.example/ad"];
    backend.url = "https://news.example/";
    const result = await buildBrowserReadAriaTool(backend, POLICY).run({}, GATE_CTX);
    expect(result.status).toBe("ok");
  });
});
