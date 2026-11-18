import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AriaSnapshot, RefDescription } from "./browser-backend.js";
import { GATE_CTX, GateBackend, facts, recordingGate } from "./browser-gate-test-helpers.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  buildBrowserActTool,
  buildBrowserClickTool,
  buildBrowserNavigateTool,
  buildBrowserScenarioTool,
  buildBrowserSearchTool,
  buildBrowserTools,
  buildBrowserTypeTool,
  ScenarioRecorder,
  ScenarioStore,
} from "./index.js";

/**
 * `browser.scenario` end to end on a fake page (ATO-960): what a
 * recording keeps, that secrets are never written, that a replay finds
 * elements by role and name on a page with new refs, and that every
 * replayed step meets the same gates as the model's own call.
 */

/** A page whose ARIA text the test sets; refs exist while they are in it. */
class PageBackend extends GateBackend {
  public page = "";
  public elements = new Map<string, RefDescription>();
  override async snapshot(): Promise<AriaSnapshot> {
    this.snapshots += 1;
    const refs = [...this.page.matchAll(/\[ref=([A-Za-z0-9]+)\]/g)].map((m) => m[1]!);
    return { url: this.url, title: "Page", text: this.page, digest: `d${this.snapshots}`, refs };
  }
  override async hasRef(ref: string): Promise<boolean> {
    return this.page.includes(`[ref=${ref}]`);
  }
  override async describeRef(ref: string): Promise<RefDescription | null> {
    return this.elements.get(ref) ?? this.element;
  }
}

const SEARCH_BOX = facts({ tag: "input", targetTag: "input", role: "searchbox", name: "Search products", editable: true, href: null });
const SEARCH_BUTTON = facts({ tag: "button", targetTag: "button", name: "Search", href: null });
const PASSWORD = facts({ tag: "input", targetTag: "input", type: "password", name: "Password", editable: true, inForm: true, href: null });
const EMAIL = facts({ tag: "input", targetTag: "input", type: "email", name: "Email", editable: true, inForm: true, href: null });
const SEND = facts({ tag: "button", targetTag: "button", name: "Send", href: null });

const SHOP_RECORDED = '- searchbox "Search products" [ref=e3]\n- button "Search" [ref=e4]\n- link "Learn more" [ref=e5]';
// Later the same page has new refs and a slightly different label.
const SHOP_LATER = '- banner\n- searchbox "Search  Products" [ref=e10]\n- button "Search" [ref=e11]';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browser-scenario-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function toolsByName(backend: PageBackend, options: DangerousToolOptions, policy?: BrowserDomainPolicy) {
  const map = new Map<string, ToolDefinition>();
  for (const tool of buildBrowserTools(backend, options, policy, {}, dir)) map.set(tool.name, tool);
  const get = (name: string) => map.get(name)!;
  return {
    scenario: (args: Record<string, unknown>) => get("browser.scenario").run(args, GATE_CTX),
    call: (name: string, args: Record<string, unknown>) => get(name).run(args, GATE_CTX),
  };
}

function writeScenario(name: string, steps: unknown[], params: unknown[] = []): void {
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ version: 1, name, createdAt: "2026-11-18T00:00:00.000Z", params, steps }),
  );
}

describe("browser.scenario: recording", () => {
  it("records navigate / type / click by role and name and turns given text into a parameter", async () => {
    const backend = new PageBackend();
    backend.page = SHOP_RECORDED;
    backend.elements.set("e3", SEARCH_BOX).set("e4", SEARCH_BUTTON);
    const t = toolsByName(backend, recordingGate(true).options);

    expect((await t.scenario({ action: "start" })).status).toBe("ok");
    await t.call("browser.navigate", { url: "https://shop.example/" });
    await t.call("browser.type", { ref: "e3", text: "running shoes" });
    await t.call("browser.click", { ref: "e4" });
    const saved = await t.scenario({ action: "stop", name: "Find Shoes", params: { query: "running shoes" } });

    expect(saved.status).toBe("ok");
    expect(saved.details).toMatchObject({ name: "find-shoes", steps: 3, params: [{ name: "query", secret: false }] });
    const file = JSON.parse(readFileSync(join(dir, "find-shoes.json"), "utf8"));
    expect(file.version).toBe(1);
    expect(file.steps).toEqual([
      { kind: "navigate", url: "https://shop.example/" },
      expect.objectContaining({ kind: "type", target: { role: "searchbox", name: "Search products" }, param: "query" }),
      expect.objectContaining({ kind: "click", target: { role: "button", name: "Search" }, url: "https://shop.example/" }),
    ]);
    expect(JSON.stringify(file)).not.toContain("running shoes");
  });

  it("never writes text typed into a password field; it becomes a secret parameter", async () => {
    const backend = new PageBackend();
    backend.page = '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]';
    backend.elements.set("e1", EMAIL).set("e2", PASSWORD);
    const { options, prompts } = recordingGate(true);
    const t = toolsByName(backend, options);

    await t.scenario({ action: "start", name: "login" });
    await t.call("browser.type", { ref: "e1", text: "me@example.com" });
    await t.call("browser.type", { ref: "e2", text: "hunter2" });
    const saved = await t.scenario({ action: "stop" });

    // The recording does not skip the gate: the password typing asked.
    expect(prompts.map((p) => p.category)).toEqual(["browser_secret"]);
    expect(saved.status).toBe("ok");
    const text = readFileSync(join(dir, "login.json"), "utf8");
    expect(text).not.toContain("hunter2");
    const file = JSON.parse(text);
    expect(file.params).toEqual([{ name: "password", secret: true }]);
    expect(file.steps[0]).toMatchObject({ kind: "type", text: "me@example.com" });
    expect(file.steps[1]).toMatchObject({ kind: "type", param: "password" });
    expect(file.steps[1].text).toBeUndefined();
  });

  it("does not record a call that failed, nor anything outside a recording", async () => {
    const backend = new PageBackend();
    backend.page = SHOP_RECORDED;
    const t = toolsByName(backend, recordingGate(true).options);

    await t.call("browser.navigate", { url: "https://shop.example/" });
    await t.scenario({ action: "start", name: "empty" });
    const stale = await t.call("browser.click", { ref: "e99" });
    expect(stale.status).toBe("error");
    const saved = await t.scenario({ action: "stop" });
    expect(saved.status).toBe("error");
    expect(saved.details.reason).toBe("empty");
    expect((await t.scenario({ action: "list" })).summary).toContain("no saved browser scenarios");
  });

  it("an upload is left out and said so at stop", async () => {
    const backend = new PageBackend();
    backend.page = '- button "Attach" [ref=e1]\n- button "Search" [ref=e4]';
    backend.elements.set("e4", SEARCH_BUTTON);
    writeFileSync(join(dir, "cv.pdf"), "x");
    const map = new Map(buildBrowserTools(backend, recordingGate(true).options, undefined, {}, dir).map((t) => [t.name, t] as const));
    const ctx = { ...GATE_CTX, workingDir: dir };
    await map.get("browser.scenario")!.run({ action: "start", name: "attach" }, ctx);
    expect((await map.get("browser.act")!.run({ action: "upload", ref: "e1", paths: ["cv.pdf"] }, ctx)).status).toBe("ok");
    await map.get("browser.click")!.run({ ref: "e4" }, ctx);
    const saved = await map.get("browser.scenario")!.run({ action: "stop" }, ctx);
    expect(saved.details.steps).toBe(1);
    expect(saved.summary).toContain("not recorded: an upload");
  });

  it("cancel discards the recording", async () => {
    const backend = new PageBackend();
    const t = toolsByName(backend, recordingGate(true).options);
    await t.scenario({ action: "start", name: "x" });
    await t.call("browser.navigate", { url: "https://shop.example/" });
    expect((await t.scenario({ action: "cancel" })).summary).toContain("discarded (1 steps)");
    expect((await t.scenario({ action: "stop" })).details.reason).toBe("not_recording");
  });
});

describe("browser.scenario: replay", () => {
  it("replays on a page with new refs, matching by role and name, with params filled in", async () => {
    const backend = new PageBackend();
    backend.page = SHOP_RECORDED;
    backend.elements.set("e3", SEARCH_BOX).set("e4", SEARCH_BUTTON).set("e10", SEARCH_BOX).set("e11", SEARCH_BUTTON);
    const { options, prompts } = recordingGate(true);
    const t = toolsByName(backend, options);
    await t.scenario({ action: "start" });
    await t.call("browser.navigate", { url: "https://shop.example/" });
    await t.call("browser.type", { ref: "e3", text: "running shoes" });
    await t.call("browser.click", { ref: "e4" });
    await t.scenario({ action: "stop", name: "find-shoes", params: { query: "running shoes" } });

    backend.page = SHOP_LATER;
    backend.navigations = [];
    backend.types = [];
    backend.clicks = [];
    const ran = await t.scenario({ action: "run", name: "find-shoes", params: { query: "trail shoes" } });

    expect(ran.status).toBe("ok");
    expect(backend.navigations.map((n) => n.url)).toEqual(["https://shop.example/"]);
    expect(backend.types).toEqual([{ ref: "e10", text: "trail shoes", pressEnter: false, clearFirst: false }]);
    expect(backend.clicks).toEqual([{ ref: "e11" }]);
    expect(ran.details).toMatchObject({ completedSteps: 3, looseMatches: [2] });
    expect(prompts).toHaveLength(0);
  });

  it("asks before a replayed commit like a normal click, and a no stops it", async () => {
    writeScenario("send-mail", [{ kind: "click", target: { role: "button", name: "Send" } }]);
    const backend = new PageBackend();
    backend.page = '- button "Send" [ref=e7]';
    backend.elements.set("e7", SEND);

    const denied = recordingGate(false);
    await expect(toolsByName(backend, denied.options).scenario({ action: "run", name: "send-mail" })).rejects.toMatchObject({
      name: "ApprovalDeniedError",
    });
    expect(denied.prompts).toHaveLength(1);
    expect(denied.prompts[0]).toMatchObject({ tool: "browser.click", category: "browser_commit" });
    expect(backend.clicks).toHaveLength(0);

    const allowed = recordingGate(true);
    const ran = await toolsByName(backend, allowed.options).scenario({ action: "run", name: "send-mail" });
    expect(ran.status).toBe("ok");
    expect(allowed.prompts.map((p) => p.category)).toEqual(["browser_commit"]);
    expect(backend.clicks).toEqual([{ ref: "e7" }]);
  });

  it("a secret parameter is required, and typing it asks as browser_secret every time", async () => {
    writeScenario(
      "login",
      [{ kind: "type", target: { role: "textbox", name: "Password" }, param: "password" }],
      [{ name: "password", secret: true }],
    );
    const backend = new PageBackend();
    backend.page = '- textbox "Password" [ref=e2]';
    backend.elements.set("e2", PASSWORD);
    const { options, prompts } = recordingGate(true);
    const t = toolsByName(backend, options);

    const missing = await t.scenario({ action: "run", name: "login" });
    expect(missing.status).toBe("error");
    expect(missing.details).toMatchObject({ reason: "missing_params", missing: ["password"] });
    expect(backend.types).toHaveLength(0);

    const ran = await t.scenario({ action: "run", name: "login", params: { password: "s3cret" } });
    expect(ran.status).toBe("ok");
    expect(prompts.map((p) => p.category)).toEqual(["browser_secret"]);
    expect(String(prompts[0]?.preview)).not.toContain("s3cret");
  });

  it("a blocked domain stops the replay before the browser moves", async () => {
    writeScenario("bank", [
      { kind: "navigate", url: "https://bank.example/login" },
      { kind: "click", target: { role: "button", name: "Search" } },
    ]);
    const backend = new PageBackend();
    const t = toolsByName(backend, recordingGate(true).options, { blockedDomains: ["bank.example"], allowedDomains: [] });
    const ran = await t.scenario({ action: "run", name: "bank" });
    expect(ran.status).toBe("error");
    expect(ran.details).toMatchObject({ failedStep: 1, completedSteps: 0, reason: "step_failed", stepReason: "blocked_domain" });
    expect(backend.navigations).toHaveLength(0);
  });

  it("stops at a step whose element is missing, naming the step", async () => {
    writeScenario("checkout", [
      { kind: "navigate", url: "https://shop.example/cart" },
      { kind: "click", target: { role: "button", name: "Checkout" } },
    ]);
    const backend = new PageBackend();
    backend.page = '- button "Continue shopping" [ref=e1]';
    const ran = await toolsByName(backend, recordingGate(true).options).scenario({ action: "run", name: "checkout", timeoutMs: 0 });
    expect(ran.status).toBe("error");
    expect(ran.summary).toContain('step 2 of 2 (click button "Checkout")');
    expect(ran.details).toMatchObject({ failedStep: 2, completedSteps: 1, reason: "target_missing" });
    expect(backend.clicks).toHaveLength(0);
  });

  it("stops when several elements match instead of guessing", async () => {
    writeScenario("add", [{ kind: "click", target: { role: "button", name: "Add" } }]);
    const backend = new PageBackend();
    backend.page = '- button "Add" [ref=e1]\n- button "Add" [ref=e2]';
    const ran = await toolsByName(backend, recordingGate(true).options).scenario({ action: "run", name: "add" });
    expect(ran.details).toMatchObject({ reason: "target_ambiguous", matches: 2 });
    expect(backend.clicks).toHaveLength(0);
  });

  it("waits for an element that shows up late", async () => {
    const backend = new PageBackend();
    backend.page = "- main";
    const options = recordingGate(true).options;
    const store = new ScenarioStore();
    let clock = 0;
    const tool = buildBrowserScenarioTool({
      backend,
      recorder: new ScenarioRecorder(backend),
      store,
      tools: {
        navigate: buildBrowserNavigateTool(backend, options),
        search: buildBrowserSearchTool(backend, options),
        click: buildBrowserClickTool(backend, options),
        type: buildBrowserTypeTool(backend, options),
        act: buildBrowserActTool(backend, options),
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 500) backend.page = '- button "Load more" [ref=e9]';
      },
    });
    await store.save({
      version: 1,
      name: "more",
      createdAt: "2026-11-18T00:00:00.000Z",
      params: [],
      steps: [{ kind: "click", target: { role: "button", name: "Load more" } }],
    });
    const ran = await tool.run({ action: "run", name: "more", timeoutMs: 2000 }, GATE_CTX);
    expect(ran.status).toBe("ok");
    expect(backend.clicks).toEqual([{ ref: "e9" }]);
  });

  it("an unknown scenario is a plain error", async () => {
    const ran = await toolsByName(new PageBackend(), recordingGate(true).options).scenario({ action: "run", name: "nope" });
    expect(ran.details).toMatchObject({ reason: "not_found" });
  });
});

describe("browser.scenario: list and delete", () => {
  it("lists saved scenarios, flags a broken file, and deletes", async () => {
    writeScenario("a-one", [{ kind: "navigate", url: "https://shop.example/" }]);
    writeFileSync(join(dir, "broken.json"), "{ not json");
    const t = toolsByName(new PageBackend(), recordingGate(true).options);

    const listed = await t.scenario({ action: "list" });
    expect(listed.summary).toContain("a-one: 1 steps");
    expect(listed.summary).toContain("broken: unreadable");

    expect((await t.scenario({ action: "delete", name: "a-one" })).status).toBe("ok");
    expect((await t.scenario({ action: "delete", name: "a-one" })).details.reason).toBe("not_found");
    await expect(t.scenario({ action: "delete", name: "../escape" })).rejects.toThrow(/name/);
  });
});
