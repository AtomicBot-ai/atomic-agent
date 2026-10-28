import { describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend, facts, recordingGate } from "./browser-gate-test-helpers.js";
import {
  buildBrowserClickTool,
  buildBrowserNavigateTool,
  buildBrowserSearchTool,
  buildBrowserTabsTool,
  buildBrowserTypeTool,
} from "./index.js";

/**
 * The click / type approval gate and the domain lists, end to end
 * through the tools against a fake backend and a fake gate. The
 * classification table itself lives in classify-browser-action.test.ts.
 */

const CTX = GATE_CTX;

/** The recorded prompts in the shape the assertions read. */
function gate(approved: boolean) {
  const { prompts, options } = recordingGate(approved);
  return { request: prompts, options };
}

function promptOf(prompts: Array<Record<string, unknown>>) {
  return prompts[0];
}

describe("browser.click approval gate", () => {
  it("a submit button asks under browser_commit, then clicks", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "button", name: "Continue", isSubmit: true, inForm: true, href: null });
    const { request, options } = gate(true);
    const result = await buildBrowserClickTool(backend, options).run({ ref: "e1" }, CTX);
    expect(result.status).toBe("ok");
    expect(request).toHaveLength(1);
    const prompt = promptOf(request);
    expect(prompt).toMatchObject({ tool: "browser.click", category: "browser_commit", affectedResources: ["shop.example"] });
    expect(prompt?.preview).toContain('"Continue"');
    expect(prompt?.preview).toContain("shop.example");
    expect(backend.clicks).toHaveLength(1);
  });

  it("a denial means the backend never clicks", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "div", role: "button", name: "Delete account", href: null });
    const { options } = gate(false);
    await expect(buildBrowserClickTool(backend, options).run({ ref: "e1" }, CTX))
      .rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(backend.clicks).toHaveLength(0);
  });

  it("a plain link does not ask", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(false);
    const result = await buildBrowserClickTool(backend, options).run({ ref: "e1" }, CTX);
    expect(result.status).toBe("ok");
    expect(request).toHaveLength(0);
    expect(backend.clicks).toHaveLength(1);
  });

  it("fails closed when the element cannot be inspected", async () => {
    const backend = new GateBackend();
    backend.describeThrows = true;
    const { request, options } = gate(true);
    await buildBrowserClickTool(backend, options).run({ ref: "e1" }, CTX);
    expect(promptOf(request)).toMatchObject({ category: "browser_commit", reason: "could not inspect element" });
  });

  it("refuses a click on a blocked host without asking", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(true);
    const tool = buildBrowserClickTool(backend, options, { blockedDomains: ["shop.example"], allowedDomains: [] });
    const result = await tool.run({ ref: "e1" }, CTX);
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("blocked_domain");
    expect(request).toHaveLength(0);
    expect(backend.clicks).toHaveLength(0);
  });
});

describe("browser.type approval gate", () => {
  it("a password asks under browser_secret and the preview never holds the text", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "password", name: "Password", editable: true, inForm: true, href: null });
    const { request, options } = gate(true);
    const secret = "hunter2-very-secret";
    await buildBrowserTypeTool(backend, options).run({ ref: "e1", text: secret, pressEnter: true }, CTX);
    const prompt = promptOf(request);
    expect(prompt?.category).toBe("browser_secret");
    expect(JSON.stringify(prompt)).not.toContain(secret);
    expect(prompt?.preview).toContain(`${secret.length} chars (hidden)`);
    expect(backend.types).toHaveLength(1);
  });

  it("a denied password is never typed", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "password", editable: true, href: null });
    const { options } = gate(false);
    await expect(buildBrowserTypeTool(backend, options).run({ ref: "e1", text: "x" }, CTX))
      .rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(backend.types).toHaveLength(0);
  });

  it("Enter in a form field asks under browser_commit and shows the text", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "textarea", name: "Comment", editable: true, inForm: true, href: null });
    const { request, options } = gate(true);
    await buildBrowserTypeTool(backend, options).run({ ref: "e1", text: "Nice post", pressEnter: true }, CTX);
    const prompt = promptOf(request);
    expect(prompt?.category).toBe("browser_commit");
    expect(prompt?.preview).toContain('"Nice post"');
    expect(prompt?.preview).toContain("then Enter");
  });

  it("Enter in a search box does not ask", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "search", editable: true, inForm: true, href: null });
    const { request, options } = gate(false);
    const result = await buildBrowserTypeTool(backend, options).run({ ref: "e1", text: "shoes", pressEnter: true }, CTX);
    expect(result.status).toBe("ok");
    expect(request).toHaveLength(0);
  });
});

describe("script URLs", () => {
  // Playwright's page.goto runs a javascript: URL in the open page, so a
  // browser_nonweb answer would otherwise cover a form submit or a payment.
  it("navigate refuses a javascript: URL without asking, even with an approving gate", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(true);
    const tool = buildBrowserNavigateTool(backend, options);
    await expect(tool.run({ url: "javascript:void(document.forms[0].submit())" }, CTX)).rejects.toThrow(/runs code in the page/);
    await expect(tool.run({ url: " JavaScript:alert(1)" }, CTX)).rejects.toThrow(/runs code in the page/);
    expect(request).toHaveLength(0);
    expect(backend.navigations).toHaveLength(0);
  });

  it("tabs new refuses a javascript: URL before the backend", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(true);
    await expect(
      buildBrowserTabsTool(backend, options).run({ action: "new", url: "javascript:void(0)" }, CTX),
    ).rejects.toThrow(/runs code in the page/);
    expect(request).toHaveLength(0);
    expect(backend.tabCalls).toBe(0);
  });

  it("file: still asks as browser_nonweb", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(true);
    await buildBrowserNavigateTool(backend, options).run({ url: "file:///tmp/page.html" }, CTX);
    expect(promptOf(request)).toMatchObject({ category: "browser_nonweb" });
  });
});

describe("browser domain lists", () => {
  const blocked = { blockedDomains: ["bank.example"], allowedDomains: [] };

  it("navigate refuses a blocked host even with approvals on and an approving gate", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(true);
    const result = await buildBrowserNavigateTool(backend, options, blocked).run({ url: "https://www.bank.example/" }, CTX);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("browser.blockedDomains");
    expect(request).toHaveLength(0);
    expect(backend.navigations).toHaveLength(0);
  });

  it("tabs new with a blocked URL is refused before the backend", async () => {
    const backend = new GateBackend();
    const { options } = gate(true);
    const result = await buildBrowserTabsTool(backend, options, blocked).run({ action: "new", url: "https://bank.example/" }, CTX);
    expect(result.status).toBe("error");
    expect(backend.tabCalls).toBe(0);
  });

  it("search on a blocked engine host is refused", async () => {
    const backend = new GateBackend();
    const { options } = gate(true);
    const tool = buildBrowserSearchTool(backend, options, { blockedDomains: ["google.com"], allowedDomains: [] });
    const result = await tool.run({ query: "x" }, CTX);
    expect(result.status).toBe("error");
    expect(backend.searches).toBe(0);
  });

  it("a host outside a non-empty allow-list asks under browser_offsite", async () => {
    const backend = new GateBackend();
    const { request, options } = gate(false);
    const tool = buildBrowserNavigateTool(backend, options, { blockedDomains: [], allowedDomains: ["github.com"] });
    await expect(tool.run({ url: "https://example.com/" }, CTX)).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(promptOf(request)).toMatchObject({ category: "browser_offsite", affectedResources: ["example.com"] });
    expect(backend.navigations).toHaveLength(0);
    await tool.run({ url: "https://github.com/x" }, CTX);
    expect(request).toHaveLength(1);
    expect(backend.navigations).toHaveLength(1);
  });
});
