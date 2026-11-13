import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend, facts, recordingGate } from "./browser-gate-test-helpers.js";
import { buildBrowserActTool } from "./index.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";

/**
 * `browser.act` end to end against the fake backend and a fake gate:
 * what asks, what is refused, what reaches the backend (ATO-957). The
 * argument table lives in page-action-args.test.ts.
 */

const BLOCKED: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [] };
const USER: BrowserDomainPolicy = { blockedDomains: [], allowedDomains: [], userProfile: true };

let dir: string;
let ctx: typeof GATE_CTX;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "browser-act-"));
  writeFileSync(join(dir, "cv.pdf"), "x".repeat(2048));
  mkdirSync(join(dir, "folder"));
  ctx = { ...GATE_CTX, workingDir: dir };
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("browser.act: actions that do not ask", () => {
  it.each([
    [{ action: "select", ref: "e1", values: ["ca"] }],
    [{ action: "hover", ref: "e1" }],
    [{ action: "back" }],
    [{ action: "forward" }],
    [{ action: "key", key: "Escape" }],
    [{ action: "key", key: "ArrowDown", ref: "e1" }],
    [{ action: "dialog", accept: false }],
    [{ action: "wait", text: "Saved" }],
    [{ action: "wait", ms: 500 }],
  ])("%o runs without a prompt", async (args) => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(false);
    const result = await buildBrowserActTool(backend, options).run(args, ctx);
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(0);
    expect(backend.acts).toHaveLength(1);
    expect(backend.acts[0]?.action).toBe(args.action);
  });

  it("a wait that timed out is a tool error the model can read", async () => {
    const backend = new GateBackend();
    backend.actResult = { done: false, note: '"Saved" was not visible within 10000 ms' };
    const result = await buildBrowserActTool(backend, recordingGate(true).options).run({ action: "wait", text: "Saved" }, ctx);
    expect(result.status).toBe("error");
    expect(result.output).toContain("not visible");
  });
});

describe("browser.act: upload", () => {
  it("asks as browser_secret with the file name and size, then uploads the resolved path", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserActTool(backend, options).run({ action: "upload", ref: "e1", paths: ["cv.pdf"] }, ctx);
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ tool: "browser.act", category: "browser_secret", affectedResources: ["shop.example"] });
    expect(String(prompts[0]?.preview)).toContain("cv.pdf (2 KB)");
    expect(String(prompts[0]?.preview)).toContain(join(dir, "cv.pdf"));
    expect(backend.acts[0]).toEqual({ action: "upload", ref: "e1", paths: [join(dir, "cv.pdf")] });
  });

  it("a denial means nothing is uploaded", async () => {
    const backend = new GateBackend();
    await expect(
      buildBrowserActTool(backend, recordingGate(false).options).run({ action: "upload", ref: "e1", paths: ["cv.pdf"] }, ctx),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(backend.acts).toHaveLength(0);
  });

  it("a missing file or a folder is an argument error before any prompt", async () => {
    for (const path of ["nope.pdf", "folder"]) {
      const backend = new GateBackend();
      const { prompts, options } = recordingGate(true);
      await expect(
        buildBrowserActTool(backend, options).run({ action: "upload", ref: "e1", path }, ctx),
      ).rejects.toThrow(/not an existing file/);
      expect(prompts).toHaveLength(0);
      expect(backend.acts).toHaveLength(0);
    }
  });
});

describe("browser.act: key", () => {
  it("Enter without a ref asks as browser_commit on the page's host", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserActTool(backend, options).run({ action: "key", key: "Control+Enter" }, ctx);
    expect(result.status).toBe("ok");
    expect(prompts[0]).toMatchObject({ category: "browser_commit", affectedResources: ["shop.example"] });
    expect(prompts[0]?.preview).toBe("press Control+Enter on shop.example");
  });

  it("Enter on a ref goes through the type gate: Enter in a form asks, Enter in a search box does not", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "input", type: "text", name: "Message", editable: true, inForm: true, href: null });
    const { prompts, options } = recordingGate(true);
    await buildBrowserActTool(backend, options).run({ action: "key", key: "Enter", ref: "e1" }, ctx);
    expect(prompts[0]).toMatchObject({ category: "browser_commit" });
    expect(String(prompts[0]?.preview)).toMatch(/^press Enter on "Message"/);

    const search = new GateBackend();
    search.element = facts({ tag: "input", type: "search", role: "searchbox", name: "Search", editable: true, href: null });
    const quiet = recordingGate(false);
    const result = await buildBrowserActTool(search, quiet.options).run({ action: "key", key: "Enter", ref: "e1" }, ctx);
    expect(result.status).toBe("ok");
    expect(quiet.prompts).toHaveLength(0);
  });

  it("Space on a ref is classified like a click on it", async () => {
    const backend = new GateBackend();
    backend.element = facts({ tag: "button", name: "Delete account", href: null });
    const { prompts, options } = recordingGate(false);
    await expect(
      buildBrowserActTool(backend, options).run({ action: "key", key: "Space", ref: "e1" }, ctx),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts[0]).toMatchObject({ category: "browser_commit" });
    expect(backend.acts).toHaveLength(0);
  });

  it("a key that lands on a blocked host clears the tab", async () => {
    const backend = new GateBackend();
    backend.landAfterAction = "https://bank.example/transfer";
    const result = await buildBrowserActTool(backend, recordingGate(true).options, BLOCKED)
      .run({ action: "key", key: "Enter" }, ctx);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "blocked_domain" });
    expect(backend.url).toBe("about:blank");
  });
});

describe("browser.act: dialog", () => {
  it("accepting asks as browser_commit and shows the prompt answer", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    await buildBrowserActTool(backend, options).run({ action: "dialog", accept: true, text: "Bob" }, ctx);
    expect(prompts[0]).toMatchObject({ category: "browser_commit", affectedResources: ["shop.example"] });
    expect(prompts[0]?.preview).toBe('accept the next dialog on shop.example, answering "Bob"');
    expect(backend.acts[0]).toEqual({ action: "dialog", accept: true, text: "Bob" });
  });

  it("in the user's own Chrome an accept asks as browser_secret", async () => {
    const backend = new GateBackend();
    const { prompts, options } = recordingGate(true);
    await buildBrowserActTool(backend, options, USER).run({ action: "dialog", accept: true }, ctx);
    expect(prompts[0]).toMatchObject({ category: "browser_secret" });
    expect(String(prompts[0]?.reason)).toMatch(/^in your own Chrome/);
  });
});

describe("browser.act: domain lists and refs", () => {
  it("any action on a blocked page is refused before the backend acts", async () => {
    for (const args of [
      { action: "select", ref: "e1", values: ["x"] },
      { action: "hover", ref: "e1" },
      { action: "upload", ref: "e1", paths: ["cv.pdf"] },
      { action: "dialog", accept: true },
      { action: "key", key: "Enter" },
    ]) {
      const backend = new GateBackend();
      backend.url = "https://www.bank.example/account";
      const { prompts, options } = recordingGate(true);
      const result = await buildBrowserActTool(backend, options, BLOCKED).run(args, ctx);
      expect(result.status, args.action).toBe("error");
      expect(result.details).toMatchObject({ reason: "blocked_domain", host: "www.bank.example" });
      expect(prompts).toHaveLength(0);
      expect(backend.acts).toHaveLength(0);
    }
  });

  it("back that lands on a blocked host clears the tab", async () => {
    const backend = new GateBackend();
    backend.landAfterAction = "https://bank.example/";
    const result = await buildBrowserActTool(backend, recordingGate(true).options, BLOCKED).run({ action: "back" }, ctx);
    expect(result.status).toBe("error");
    expect(backend.url).toBe("about:blank");
  });

  it("a stale ref fails fast without asking or acting", async () => {
    const backend = new GateBackend();
    backend.refPresent = false;
    const { prompts, options } = recordingGate(true);
    const result = await buildBrowserActTool(backend, options).run({ action: "upload", ref: "e7", paths: ["cv.pdf"] }, ctx);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ ref: "e7", reason: "stale_ref" });
    expect(prompts).toHaveLength(0);
    expect(backend.acts).toHaveLength(0);
  });

  it("a backend without act reports it is unsupported", async () => {
    const backend = new GateBackend() as GateBackend & { act?: unknown };
    Object.defineProperty(backend, "act", { value: undefined });
    const result = await buildBrowserActTool(backend as never, recordingGate(true).options).run({ action: "back" }, ctx);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "unsupported" });
  });
});
