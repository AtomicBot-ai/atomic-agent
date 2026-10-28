import { describe, expect, it } from "vitest";
import { GATE_CTX as CTX, GateBackend, facts, recordingGate } from "./browser-gate-test-helpers.js";
import {
  buildBrowserClickTool,
  buildBrowserNavigateTool,
  buildBrowserReadAriaTool,
  buildBrowserTabsTool,
  buildBrowserTypeTool,
} from "./index.js";

/**
 * The domain lists past the URL the model asked for: where a link or a
 * form goes, where an action landed, what a snapshot may show, and what
 * still holds when the element cannot be read.
 */
const BLOCKED = { blockedDomains: ["bank.example"], allowedDomains: [] };

describe("link and form targets", () => {
  it("a link to a blocked host is refused and never clicked", async () => {
    const backend = new GateBackend();
    backend.element = facts({ href: "https://www.bank.example/transfer" });
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserClickTool(backend, options, BLOCKED).run({ ref: "e1" }, CTX);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "blocked_domain", host: "www.bank.example" });
    expect(prompts).toHaveLength(0);
    expect(backend.clicks).toHaveLength(0);
  });

  it("a relative link resolves against the page, so a link on an allowed page stays quiet", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    const tool = buildBrowserClickTool(backend, options, { blockedDomains: [], allowedDomains: ["shop.example"] });
    const result = await tool.run({ ref: "e1" }, CTX);
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(0);
  });

  it("a link outside a non-empty allow-list asks under browser_offsite; denied means no click", async () => {
    const backend = new GateBackend();
    backend.element = facts({ href: "https://elsewhere.test/x" });
    const { prompts, options } = recordingGate(false);
    const tool = buildBrowserClickTool(backend, options, { blockedDomains: [], allowedDomains: ["shop.example"] });
    await expect(tool.run({ ref: "e1" }, CTX)).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts[0]).toMatchObject({ category: "browser_offsite", affectedResources: ["elsewhere.test"] });
    expect(backend.clicks).toHaveLength(0);
  });

  it("a submit whose form posts to a blocked host is refused", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "button", name: "Go", href: null, isSubmit: true, inForm: true, formAction: "https://bank.example/pay" });
    const { options } = recordingGate(true);
    const result = await buildBrowserClickTool(backend, options, BLOCKED).run({ ref: "e1" }, CTX);
    expect(result.details.reason).toBe("blocked_domain");
    expect(backend.clicks).toHaveLength(0);
  });

  it("Enter in a form that posts to a blocked host is refused", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", name: "q", href: null, editable: true, inForm: true, inSearchForm: true, formAction: "https://bank.example/find" });
    const { options } = recordingGate(true);
    const result = await buildBrowserTypeTool(backend, options, BLOCKED).run({ ref: "e1", text: "x", pressEnter: true }, CTX);
    expect(result.details.reason).toBe("blocked_domain");
    expect(backend.types).toHaveLength(0);
  });
});

describe("where an action landed", () => {
  it("a navigation redirected to a blocked host clears the tab and returns blocked_domain", async () => {
    const backend = new GateBackend();
    backend.redirects.set("https://short.link/x", "https://bank.example/login");
    const { options } = recordingGate(true);
    const result = await buildBrowserNavigateTool(backend, options, BLOCKED).run({ url: "https://short.link/x" }, CTX);
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("blocked_domain");
    expect(result.details.worldSnapshot).toBeUndefined();
    expect(backend.navigations.at(-1)?.url).toBe("about:blank");
    expect(backend.snapshots).toBe(0);
  });

  it("a click that lands on a blocked host clears the tab", async () => {
    const backend = new GateBackend();
    backend.landAfterAction = "https://bank.example/";
    const { options } = recordingGate(true);
    const result = await buildBrowserClickTool(backend, options, BLOCKED).run({ ref: "e1" }, CTX);
    expect(result.details.reason).toBe("blocked_domain");
    expect(backend.navigations.at(-1)?.url).toBe("about:blank");
  });

  it("Enter that lands on a blocked host clears the tab", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "search", href: null, editable: true, inForm: true });
    backend.landAfterAction = "https://bank.example/";
    const { options } = recordingGate(true);
    const result = await buildBrowserTypeTool(backend, options, BLOCKED).run({ ref: "e1", text: "x", pressEnter: true }, CTX);
    expect(result.details.reason).toBe("blocked_domain");
  });

  it("tabs new that redirects to a blocked host clears the tab", async () => {
    const backend = new GateBackend();
    backend.url = "https://bank.example/";
    const { options } = recordingGate(true);
    const result = await buildBrowserTabsTool(backend, options, BLOCKED).run({ action: "new", url: "https://short.link/y" }, CTX);
    expect(result.details.reason).toBe("blocked_domain");
    expect(backend.navigations.at(-1)?.url).toBe("about:blank");
  });
});

describe("snapshots of a blocked page", () => {
  it("read_aria refuses and sends no page content", async () => {
    const backend = new GateBackend();
    backend.url = "https://bank.example/account";
    const result = await buildBrowserReadAriaTool(backend, BLOCKED).run({}, CTX);
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("blocked_domain");
    expect(result.details.worldSnapshot).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret page text");
  });

  it("read_aria on an allowed page still returns the tree", async () => {
    const backend = new GateBackend();
    const result = await buildBrowserReadAriaTool(backend, BLOCKED).run({}, CTX);
    expect(result.status).toBe("ok");
    expect(result.details.worldSnapshot).toBeDefined();
  });
});

describe("when the element cannot be read", () => {
  it("the page host still comes from the backend, so a blocked page is refused", async () => {
    const backend = new GateBackend();
    backend.describeThrows = true;
    backend.url = "https://bank.example/";
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserClickTool(backend, options, BLOCKED).run({ ref: "e1" }, CTX);
    expect(result.details.reason).toBe("blocked_domain");
    expect(prompts).toHaveLength(0);
    expect(backend.clicks).toHaveLength(0);
  });

  it("typing into it asks as a secret and hides the text", async () => {
    const backend = new GateBackend();
    backend.element = null;
    const { prompts, options } = recordingGate(true);
    await buildBrowserTypeTool(backend, options).run({ ref: "e1", text: "maybe-a-password" }, CTX);
    expect(prompts[0]).toMatchObject({ category: "browser_secret", reason: "could not inspect element" });
    expect(JSON.stringify(prompts[0])).not.toContain("maybe-a-password");
  });
});
