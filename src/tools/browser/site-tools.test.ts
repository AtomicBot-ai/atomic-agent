import { describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";
import { UserSiteApprovals } from "./user-profile-sites.js";
import type {
  SiteToolCallInput,
  SiteToolCallResult,
  SiteToolsListInput,
  SiteToolsListing,
} from "./browser-backend.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import { buildBrowserSiteToolsTool, SITE_TOOL_SOURCE } from "./site-tools.js";

/** `browser.site_tools` (ATO-521) against a fake backend and a fake approval gate. */

class SiteToolsBackend extends GateBackend {
  public declared: unknown[] = [
    {
      name: "search",
      title: "Search",
      description: "Find products in the shop",
      inputSchema: JSON.stringify({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      }),
      readOnlyHint: true,
    },
  ];
  public calls: SiteToolCallInput[] = [];
  public answer: Omit<SiteToolCallResult, "url" | "frameUrls"> = { ok: true, text: "3 results", isError: false };
  public frames: string[] = [];
  /** Where the page is once the tool answered. */
  public landAfterCall: string | null = null;
  public listInputs: SiteToolsListInput[] = [];

  async listSiteTools(input: SiteToolsListInput): Promise<SiteToolsListing> {
    this.listInputs.push(input);
    return { url: this.url, frameUrls: [this.url, ...this.frames], tools: this.declared, total: this.declared.length };
  }

  async callSiteTool(input: SiteToolCallInput): Promise<SiteToolCallResult> {
    this.calls.push(input);
    if (this.landAfterCall !== null) this.url = this.landAfterCall;
    return { url: this.url, frameUrls: [this.url], ...this.answer };
  }
}

const NO_POLICY: BrowserDomainPolicy = { blockedDomains: [], allowedDomains: [] };

describe("browser.site_tools list", () => {
  it("lists the page's tools with schemas, marks the output as the site's text, and never asks", async () => {
    const backend = new SiteToolsBackend();
    const { prompts, options } = recordingGate(false);
    const tool = buildBrowserSiteToolsTool(backend, options);
    expect(tool.untrustedOutput).toBe(SITE_TOOL_SOURCE);
    const result = await tool.run({ action: "list" }, GATE_CTX);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("search (Search): Find products in the shop [the site says it only reads]");
    expect(result.summary).toContain('"required":["query"]');
    expect(result.summary).toContain("shop.example");
    expect(result.details).toMatchObject({ tools: ["search"], total: 1 });
    expect(prompts).toHaveLength(0);
  });

  it("says so when the page declares nothing", async () => {
    const backend = new SiteToolsBackend();
    backend.declared = [];
    const result = await buildBrowserSiteToolsTool(backend, recordingGate(true).options).run({ action: "list" }, GATE_CTX);
    expect(result.summary).toContain("declares no site tools");
  });

  it("refuses a blocked page, before and after the read", async () => {
    const backend = new SiteToolsBackend();
    const policy: BrowserDomainPolicy = { blockedDomains: ["shop.example"], allowedDomains: [] };
    const blocked = await buildBrowserSiteToolsTool(backend, recordingGate(true).options, policy).run({ action: "list" }, GATE_CTX);
    expect(blocked.details).toMatchObject({ reason: "blocked_domain" });
    expect(backend.listInputs).toHaveLength(0);

    backend.frames = ["https://bank.example/widget"];
    const framed = await buildBrowserSiteToolsTool(
      backend,
      recordingGate(true).options,
      { blockedDomains: ["bank.example"], allowedDomains: [] },
    ).run({ action: "list" }, GATE_CTX);
    expect(framed.details).toMatchObject({ reason: "blocked_domain", host: "bank.example" });
  });

  it("is an error, not a crash, on a backend without site tools", async () => {
    const result = await buildBrowserSiteToolsTool(new GateBackend(), recordingGate(true).options).run({ action: "list" }, GATE_CTX);
    expect(result.details).toMatchObject({ reason: "unsupported" });
  });

  it("rejects an unknown action", async () => {
    await expect(
      buildBrowserSiteToolsTool(new SiteToolsBackend(), recordingGate(true).options).run({ action: "run" }, GATE_CTX),
    ).rejects.toThrow("list|call");
  });
});

describe("browser.site_tools call", () => {
  it("asks as browser_site_tool for this site, then runs the tool", async () => {
    const backend = new SiteToolsBackend();
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserSiteToolsTool(backend, options, NO_POLICY).run(
      { action: "call", name: "search", arguments: { query: "shoes" } },
      GATE_CTX,
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("3 results");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      tool: "browser.site_tools",
      category: "browser_site_tool",
      affectedResources: ["shop.example"],
    });
    expect(prompts[0]?.preview).toContain('"search"');
    expect(prompts[0]?.preview).toContain('{"query":"shoes"}');
    expect(backend.calls).toEqual([{ name: "search", argsJson: '{"query":"shoes"}', timeoutMs: 30_000, maxResultChars: 20_000 }]);
  });

  it("the site's read-only hint does not skip the prompt, and a no means it never runs", async () => {
    const backend = new SiteToolsBackend();
    const { prompts, options } = recordingGate(false);
    await expect(
      buildBrowserSiteToolsTool(backend, options).run({ action: "call", name: "search", arguments: { query: "x" } }, GATE_CTX),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts).toHaveLength(1);
    expect(backend.calls).toHaveLength(0);
  });

  it("in the user's own Chrome it asks as browser_secret", async () => {
    const backend = new SiteToolsBackend();
    const { prompts, options } = recordingGate(true);
    const policy: BrowserDomainPolicy = {
      blockedDomains: [],
      allowedDomains: ["shop.example"],
      userProfile: true,
      userSites: new UserSiteApprovals(),
    };
    await buildBrowserSiteToolsTool(backend, options, policy).run(
      { action: "call", name: "search", arguments: '{"query":"x"}' },
      GATE_CTX,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: "browser_secret" });
    expect(String(prompts[0]?.reason)).toContain("your own Chrome");
  });

  it("refuses an undeclared tool and arguments that do not fit, without asking", async () => {
    const backend = new SiteToolsBackend();
    const { prompts, options } = recordingGate(true);
    const tool = buildBrowserSiteToolsTool(backend, options);
    const missing = await tool.run({ action: "call", name: "delete_account" }, GATE_CTX);
    expect(missing.details).toMatchObject({ reason: "not_found" });
    const wrong = await tool.run({ action: "call", name: "search", arguments: { query: 5 } }, GATE_CTX);
    expect(wrong.details).toMatchObject({ reason: "bad_arguments" });
    expect(wrong.summary).toContain("`query` should be string");
    await expect(tool.run({ action: "call", name: "bad name" }, GATE_CTX)).rejects.toThrow("`name`");
    await expect(tool.run({ action: "call", name: "search", arguments: [1] }, GATE_CTX)).rejects.toThrow("`arguments`");
    await expect(tool.run({ action: "call", name: "search", arguments: "{oops" }, GATE_CTX)).rejects.toThrow("`arguments`");
    expect(prompts).toHaveLength(0);
    expect(backend.calls).toHaveLength(0);
  });

  it("clamps the timeout and reports a tool that did not answer or failed", async () => {
    const backend = new SiteToolsBackend();
    const tool = buildBrowserSiteToolsTool(backend, recordingGate(true).options);
    backend.answer = { ok: false, text: "", isError: false, error: "timeout" };
    const slow = await tool.run({ action: "call", name: "search", arguments: { query: "x" }, timeoutMs: 999_999 }, GATE_CTX);
    expect(backend.calls[0]?.timeoutMs).toBe(120_000);
    expect(slow.status).toBe("error");
    expect(slow.summary).toContain("did not answer within 120 s");
    backend.answer = { ok: false, text: "", isError: false, error: "threw", message: "quota exceeded" };
    const failed = await tool.run({ action: "call", name: "search", arguments: { query: "x" } }, GATE_CTX);
    expect(failed.summary).toContain("failed: quota exceeded");
    backend.answer = { ok: true, text: "out of stock", isError: true };
    const siteError = await tool.run({ action: "call", name: "search", arguments: { query: "x" } }, GATE_CTX);
    expect(siteError.status).toBe("error");
    expect(siteError.summary).toContain("reported an error");
  });

  it("throws the answer away when the page moved to a blocked site", async () => {
    const backend = new SiteToolsBackend();
    backend.landAfterCall = "https://bank.example/transfer";
    backend.answer = { ok: true, text: "account 1234", isError: false };
    const result = await buildBrowserSiteToolsTool(
      backend,
      recordingGate(true).options,
      { blockedDomains: ["bank.example"], allowedDomains: [] },
    ).run({ action: "call", name: "search", arguments: { query: "x" } }, GATE_CTX);
    expect(result.details).toMatchObject({ reason: "blocked_domain" });
    expect(result.summary).not.toContain("1234");
  });

  it("cuts a long answer and says so", async () => {
    const backend = new SiteToolsBackend();
    backend.answer = { ok: true, text: "y".repeat(20_001), isError: false };
    const result = await buildBrowserSiteToolsTool(backend, recordingGate(true).options).run(
      { action: "call", name: "search", arguments: { query: "x" } },
      GATE_CTX,
    );
    expect(result.details).toMatchObject({ truncated: true });
  });
});
