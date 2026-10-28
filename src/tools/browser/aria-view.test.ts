import { describe, expect, it } from "vitest";
import {
  AriaSnapshotStore,
  ariaCharBudget,
  defaultAriaViewMode,
  parseAriaViewMode,
  readAriaView,
} from "./aria-view.js";
import { GATE_CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";
import { buildBrowserNavigateTool, buildBrowserReadAriaTool } from "./index.js";
import type { AriaSnapshot, TabInfo } from "./browser-backend.js";

/** Choosing and serving the page view (ATO-956) through read_aria and navigate. */

class PageBackend extends GateBackend {
  public pages: string[] = [];
  public fullCalls: boolean[] = [];
  override async snapshot(options: { full?: boolean } = {}): Promise<AriaSnapshot> {
    this.fullCalls.push(options.full === true);
    const body = this.pages.shift() ?? this.last;
    this.last = body;
    return { url: this.url, title: "Shop", text: `url: ${this.url}\ntitle: Shop\n\n${body}`, digest: "d0", refs: [] };
  }
  last = '- button "Buy" [ref=e1]';
  override async tabs(): Promise<{ tabs: TabInfo[] }> {
    return { tabs: [{ index: 0, url: this.url, title: "Shop", active: true }] };
  }
}

const TREE = ['- main [ref=e1]:', '  - paragraph [ref=e2]: Long product text', '  - button "Add to cart" [ref=e3]'].join("\n");

describe("view choice", () => {
  it("defaults to interactive for a local model or a small window, full otherwise", () => {
    expect(defaultAriaViewMode({ modelMode: "local" })).toBe("interactive");
    expect(defaultAriaViewMode({ modelMode: "cloud", contextWindowTokens: 16_384 })).toBe("interactive");
    expect(defaultAriaViewMode({ modelMode: "cloud", contextWindowTokens: 200_000 })).toBe("full");
    expect(defaultAriaViewMode({})).toBe("full");
  });

  it("budgets 4% of the window, clamped", () => {
    expect(ariaCharBudget(8_192)).toBe(2_000);
    expect(ariaCharBudget(32_768)).toBe(5_243);
    expect(ariaCharBudget(1_000_000)).toBe(ariaCharBudget(undefined));
  });

  it("rejects an unknown mode", () => {
    expect(parseAriaViewMode("tiny")).toMatchObject({ error: expect.stringContaining("full") });
    expect(parseAriaViewMode(undefined)).toBeUndefined();
  });
});

describe("browser.read_aria views", () => {
  it("a local model gets the interactive view by default; full stays available", async () => {
    const backend = new PageBackend();
    backend.pages = [TREE, TREE];
    const tool = buildBrowserReadAriaTool(backend);
    const compact = await tool.run({}, { ...GATE_CTX, modelMode: "local" });
    const world = (compact.details as { worldSnapshot: { text: string } }).worldSnapshot.text;
    expect(world).toContain("view: interactive");
    expect(world).toContain('[e3] button "Add to cart"');
    expect(world).not.toContain("Long product text");
    // Compact views read the whole tree so no control is lost to the backend's cut.
    expect(backend.fullCalls[0]).toBe(true);

    const full = await tool.run({ mode: "full" }, { ...GATE_CTX, modelMode: "local" });
    expect((full.details as { worldSnapshot: { text: string } }).worldSnapshot.text).toContain("Long product text");
  });

  it("diff compares against the tab's previous snapshot, including one taken by navigate", async () => {
    const backend = new PageBackend();
    const store = new AriaSnapshotStore();
    const { options } = recordingGate(true);
    backend.pages = [TREE, TREE.replace('"Add to cart"', '"Added ✓" [disabled]')];
    await buildBrowserNavigateTool(backend, options, undefined, store).run(
      { url: "https://shop.example/cart" },
      { ...GATE_CTX, modelMode: "local" },
    );
    const diff = await buildBrowserReadAriaTool(backend, undefined, store).run(
      { mode: "diff" },
      { ...GATE_CTX, modelMode: "local" },
    );
    const text = (diff.details as { worldSnapshot: { text: string } }).worldSnapshot.text;
    expect(text).toContain("view: diff");
    expect(text).toContain('~ [e3] button "Added ✓" [disabled]');
  });

  it("region needs a ref that is on the page", async () => {
    const backend = new PageBackend();
    backend.pages = [TREE, TREE];
    const tool = buildBrowserReadAriaTool(backend);
    const missing = await tool.run({ mode: "region" }, GATE_CTX);
    expect(missing.status).toBe("error");
    const gone = await tool.run({ mode: "region", ref: "e42" }, GATE_CTX);
    expect(gone.status).toBe("error");
    await expect(tool.run({ mode: "bogus" }, GATE_CTX)).rejects.toThrow(/mode/);
  });

  it("a blocked page renders no view and is not remembered", async () => {
    const backend = new PageBackend();
    backend.url = "https://bank.example/";
    const store = new AriaSnapshotStore();
    const result = await readAriaView(
      backend,
      { mode: "interactive" },
      { sessionId: "s" },
      { blockedDomains: ["bank.example"], allowedDomains: [] },
      store,
    );
    expect(result.kind).toBe("blocked");
    expect(store.size).toBe(0);
  });

  it("a cloud model with a large window keeps the whole tree after navigate", async () => {
    const backend = new PageBackend();
    backend.pages = [TREE];
    const { options } = recordingGate(true);
    const nav = await buildBrowserNavigateTool(backend, options).run(
      { url: "https://shop.example/" },
      { ...GATE_CTX, modelMode: "cloud", contextWindowTokens: 200_000 },
    );
    expect((nav.details as { worldSnapshot: { text: string } }).worldSnapshot.text).toContain("Long product text");
  });
});

describe("AriaSnapshotStore", () => {
  it("keeps the most recent entries only", () => {
    const store = new AriaSnapshotStore(2);
    store.set("a", { url: "u", text: "1" });
    store.set("b", { url: "u", text: "2" });
    store.set("c", { url: "u", text: "3" });
    expect(store.get("a")).toBeUndefined();
    expect(store.size).toBe(2);
  });
});
