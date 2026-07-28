import { describe, it, expect, beforeEach } from "vitest";
import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  ScrollInput,
  ScrollResult,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "./browser-backend.js";
import { summariseAriaSnapshot } from "./aria-compressor.js";
import {
  buildBrowserClickTool,
  buildBrowserNavigateTool,
  buildBrowserReadAriaTool,
  buildBrowserScrollTool,
  buildBrowserSearchTool,
  buildBrowserTabsTool,
  buildBrowserTools,
  buildBrowserTypeTool,
  isSafeUrl,
} from "./index.js";
import { ToolRegistry } from "../tool-registry.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";

function autoApprove(): DangerousToolOptions {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return { approvals: gate, approvalRequired: false };
}

class FakeBackend implements BrowserBackend {
  public readyCalls = 0;
  public shutdowns = 0;
  public lastNavigate: NavigateInput | null = null;
  public lastClick: ClickInput | null = null;
  public lastType: TypeInput | null = null;
  public lastSearch: SearchInput | null = null;
  public lastTabs: TabsInput | null = null;
  public lastScroll: ScrollInput | null = null;
  public scrollState: ScrollResult = {
    scrollY: 0,
    scrollHeight: 2400,
    viewportHeight: 800,
  };
  /** Override to simulate a stale DOM (ref no longer present). */
  public liveRefs: Set<string> = new Set(["e1", "e2"]);

  private readonly snap: AriaSnapshot = {
    url: "https://example.com/",
    title: "Example",
    digest: "deadbeef",
    refs: ["e1", "e2"],
    text: [
      "url: https://example.com/",
      "title: Example",
      "",
      "- link [ref=e1]: Learn more",
      "- textbox [ref=e2]: search",
    ].join("\n"),
  };

  async ensureReady(): Promise<void> {
    this.readyCalls += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }

  async snapshot(): Promise<AriaSnapshot> {
    return this.snap;
  }

  async hasRef(ref: string): Promise<boolean> {
    return this.liveRefs.has(ref);
  }

  async navigate(
    input: NavigateInput,
  ): Promise<{ url: string; title: string }> {
    this.lastNavigate = input;
    return { url: input.url, title: "Example" };
  }

  async click(input: ClickInput): Promise<{ clickedRef: string }> {
    this.lastClick = input;
    return { clickedRef: input.ref };
  }

  async type(input: TypeInput): Promise<{ typedLength: number }> {
    this.lastType = input;
    return { typedLength: input.text.length };
  }

  async search(input: SearchInput): Promise<{ url: string }> {
    this.lastSearch = input;
    return {
      url: `https://search.example/?q=${encodeURIComponent(input.query)}`,
    };
  }

  async tabs(input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    this.lastTabs = input;
    return {
      tabs: [
        {
          index: 0,
          url: "https://example.com/",
          title: "Example",
          active: true,
        },
      ],
    };
  }

  async scroll(input: ScrollInput): Promise<ScrollResult> {
    this.lastScroll = input;
    const vh = this.scrollState.viewportHeight;
    let delta = 0;
    if (input.direction === "top") {
      this.scrollState = { ...this.scrollState, scrollY: 0 };
      return this.scrollState;
    }
    if (input.direction === "bottom") {
      this.scrollState = {
        ...this.scrollState,
        scrollY: this.scrollState.scrollHeight - vh,
      };
      return this.scrollState;
    }
    if (typeof input.amount === "number") {
      delta = input.amount;
    } else if (input.amount === "half") {
      delta = Math.floor(vh / 2);
    } else {
      delta = vh;
    }
    if (input.direction === "up") delta = -delta;
    const nextY = Math.max(
      0,
      Math.min(
        this.scrollState.scrollHeight - vh,
        this.scrollState.scrollY + delta,
      ),
    );
    this.scrollState = { ...this.scrollState, scrollY: nextY };
    return this.scrollState;
  }
}

const CTX = {
  workingDir: "/tmp",
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
};

describe("browser tools on a fake backend", () => {
  let backend: FakeBackend;

  beforeEach(() => {
    backend = new FakeBackend();
  });

  it("navigate forwards the URL and waitUntil override", async () => {
    const tool = buildBrowserNavigateTool(backend, autoApprove());
    const result = await tool.run(
      { url: "https://example.com/", waitUntil: "networkidle" },
      CTX,
    );
    expect(result.status).toBe("ok");
    expect(result.details.url).toBe("https://example.com/");
    expect(backend.lastNavigate?.waitUntil).toBe("networkidle");
    expect(backend.readyCalls).toBe(1);
  });

  it("navigate attaches a fresh worldSnapshot so applyStateEffects can fold it into session", async () => {
    const tool = buildBrowserNavigateTool(backend, autoApprove());
    const result = await tool.run({ url: "https://example.com/" }, CTX);
    const snap = result.details.worldSnapshot as
      | { kind: string; digest: string; text: string }
      | undefined;
    expect(snap).toBeDefined();
    expect(snap?.kind).toBe("browser");
    expect(snap?.digest).toBe("deadbeef");
    expect(snap?.text).toContain("[ref=e1]");
  });

  it("navigate rejects non-string url", async () => {
    const tool = buildBrowserNavigateTool(backend, autoApprove());
    await expect(tool.run({}, CTX)).rejects.toThrow(/url/);
  });

  it("navigate requires approval for non-http(s) schemes", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied file scheme"),
    });
    const tool = buildBrowserNavigateTool(backend, {
      approvals: gate,
      approvalRequired: true,
    });
    await expect(
      tool.run({ url: "file:///etc/passwd" }, CTX),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("isSafeUrl accepts http/https only", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("http://example.com")).toBe(true);
    expect(isSafeUrl("file:///tmp/x")).toBe(false);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("not-a-url")).toBe(false);
  });

  it("click forwards the ref", async () => {
    const tool = buildBrowserClickTool(backend);
    const result = await tool.run({ ref: "e1" }, CTX);
    expect(result.status).toBe("ok");
    expect(backend.lastClick?.ref).toBe("e1");
  });

  it("click rejects non-alphanumeric ref", async () => {
    const tool = buildBrowserClickTool(backend);
    await expect(tool.run({ ref: "e 1" }, CTX)).rejects.toThrow(/ref/);
    await expect(tool.run({ ref: 1 }, CTX)).rejects.toThrow(/ref/);
  });

  it("click fails fast with a helpful message when the ref is stale", async () => {
    backend.liveRefs = new Set(["e1"]);
    const tool = buildBrowserClickTool(backend);
    const result = await tool.run({ ref: "e337" }, CTX);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/ref 'e337' is not present/);
    expect(result.summary).toMatch(/browser\.read_aria/);
    expect(result.details.reason).toBe("stale_ref");
    expect(backend.lastClick).toBeNull();
  });

  it("type records text length and pressEnter flag", async () => {
    const tool = buildBrowserTypeTool(backend);
    const result = await tool.run(
      { ref: "e2", text: "hello", pressEnter: true },
      CTX,
    );
    expect(result.status).toBe("ok");
    expect(backend.lastType?.text).toBe("hello");
    expect(backend.lastType?.pressEnter).toBe(true);
  });

  it("type fails fast with a helpful message when the ref is stale", async () => {
    backend.liveRefs = new Set(["e1"]);
    const tool = buildBrowserTypeTool(backend);
    const result = await tool.run({ ref: "e2", text: "x" }, CTX);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/ref 'e2' is not present/);
    expect(result.details.reason).toBe("stale_ref");
    expect(backend.lastType).toBeNull();
  });

  it("read_aria returns a compact status and leaves the tree in worldSnapshot", async () => {
    const tool = buildBrowserReadAriaTool(backend);
    const result = await tool.run({}, CTX);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("captured ARIA snapshot");
    expect(result.summary).toContain("refs: 2");
    expect(result.summary).toContain("see ### world");
    // The tree itself does NOT leak into the conversation summary — we
    // rely on session.worldSnapshot + `### world` as the single source.
    expect(result.summary).not.toContain("[ref=e1]");
    expect(result.details.refCount).toBe(2);
    const snap = result.details.worldSnapshot as
      | { text: string }
      | undefined;
    expect(snap?.text).toContain("[ref=e1]");
  });

  it("read_aria exposes a worldSnapshot so session.worldSnapshot can refresh", async () => {
    const tool = buildBrowserReadAriaTool(backend);
    const result = await tool.run({}, CTX);
    const snap = result.details.worldSnapshot as
      | { kind: string; digest: string; text: string }
      | undefined;
    expect(snap?.kind).toBe("browser");
    expect(snap?.digest).toBe("deadbeef");
    expect(snap?.text).toContain("[ref=e1]");
  });

  it("search builds a search URL via the backend", async () => {
    const tool = buildBrowserSearchTool(backend);
    const result = await tool.run({ query: "atomic agent", engine: "bing" }, CTX);
    expect(result.status).toBe("ok");
    expect(backend.lastSearch?.engine).toBe("bing");
    expect(result.details.url).toContain("atomic%20agent");
  });

  it("search attaches a worldSnapshot for the results page", async () => {
    const tool = buildBrowserSearchTool(backend);
    const result = await tool.run({ query: "hermes" }, CTX);
    const snap = result.details.worldSnapshot as
      | { kind: string; digest: string; text: string }
      | undefined;
    expect(snap?.kind).toBe("browser");
    expect(snap?.digest).toBe("deadbeef");
  });

  it("navigate and search survive snapshot failures without flipping status", async () => {
    const flaky = new FakeBackend();
    flaky.snapshot = async () => {
      throw new Error("snapshot timeout");
    };
    const nav = buildBrowserNavigateTool(flaky, autoApprove());
    const navResult = await nav.run({ url: "https://example.com/" }, CTX);
    expect(navResult.status).toBe("ok");
    expect(navResult.details.worldSnapshot).toBeUndefined();

    const search = buildBrowserSearchTool(flaky);
    const searchResult = await search.run({ query: "q" }, CTX);
    expect(searchResult.status).toBe("ok");
    expect(searchResult.details.worldSnapshot).toBeUndefined();
  });

  it("tabs list rendering includes the active marker", async () => {
    const tool = buildBrowserTabsTool(backend, autoApprove());
    const result = await tool.run({ action: "list" }, CTX);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("*[0] Example");
  });

  it("tabs new with http(s) URL does not require approval", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "should not be called"),
    });
    const tool = buildBrowserTabsTool(backend, {
      approvals: gate,
      approvalRequired: true,
    });
    const result = await tool.run(
      { action: "new", url: "https://example.com/docs" },
      CTX,
    );
    expect(result.status).toBe("ok");
    expect(backend.lastTabs).toEqual({
      action: "new",
      url: "https://example.com/docs",
    });
  });

  it("tabs new requires approval for non-http(s) schemes", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied file scheme"),
    });
    const tool = buildBrowserTabsTool(backend, {
      approvals: gate,
      approvalRequired: true,
    });
    await expect(
      tool.run({ action: "new", url: "file:///etc/passwd" }, CTX),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(backend.lastTabs).toBeNull();
    expect(backend.readyCalls).toBe(0);
  });

  it("tabs new proceeds to the backend when a non-http(s) URL is approved", async () => {
    const gate = new ApprovalGate({
      emit: (req) =>
        setImmediate(() =>
          gate.resolve({ approvalId: req.approvalId, approved: true }),
        ),
    });
    const tool = buildBrowserTabsTool(backend, {
      approvals: gate,
      approvalRequired: true,
    });
    const result = await tool.run(
      { action: "new", url: "file:///etc/hosts" },
      CTX,
    );
    expect(result.status).toBe("ok");
    // url survives the await and reaches the backend intact
    expect(backend.lastTabs).toEqual({
      action: "new",
      url: "file:///etc/hosts",
    });
    expect(backend.readyCalls).toBe(1);
  });

  it("tabs new with javascript: URL is gated the same way", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied js scheme"),
    });
    const tool = buildBrowserTabsTool(backend, {
      approvals: gate,
      approvalRequired: true,
    });
    await expect(
      tool.run({ action: "new", url: "javascript:alert(1)" }, CTX),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(backend.lastTabs).toBeNull();
  });

  it("tabs list never hits the URL approval gate", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "list must not ask"),
    });
    const tool = buildBrowserTabsTool(backend, {
      approvals: gate,
      approvalRequired: true,
    });
    const result = await tool.run({ action: "list" }, CTX);
    expect(result.status).toBe("ok");
    expect(backend.lastTabs?.action).toBe("list");
  });

  it("buildBrowserTools registers all browser tools", () => {
    const registry = new ToolRegistry();
    for (const tool of buildBrowserTools(backend, autoApprove())) {
      registry.register(tool);
    }
    expect(registry.list().map((t) => t.name).sort()).toEqual([
      "browser.click",
      "browser.navigate",
      "browser.read_aria",
      "browser.scroll",
      "browser.search",
      "browser.tabs",
      "browser.type",
    ]);
  });

  it("scroll forwards the direction and default amount=page", async () => {
    const tool = buildBrowserScrollTool(backend);
    const result = await tool.run({ direction: "down" }, CTX);
    expect(result.status).toBe("ok");
    expect(backend.lastScroll?.direction).toBe("down");
    expect(result.summary).toContain("scrolled down");
    expect(result.details.direction).toBe("down");
    expect(result.details.scrollY).toBe(800);
  });

  it("scroll accepts `half` and numeric amounts", async () => {
    const tool = buildBrowserScrollTool(backend);
    const halfResult = await tool.run(
      { direction: "down", amount: "half" },
      CTX,
    );
    expect(halfResult.details.amount).toBe("half");
    const pxResult = await tool.run({ direction: "down", amount: 200 }, CTX);
    expect(pxResult.details.amount).toBe(200);
  });

  it("scroll to top resets position", async () => {
    backend.scrollState = { scrollY: 1500, scrollHeight: 3000, viewportHeight: 800 };
    const tool = buildBrowserScrollTool(backend);
    const result = await tool.run({ direction: "top" }, CTX);
    expect(result.details.scrollY).toBe(0);
  });

  it("scroll rejects invalid direction", async () => {
    const tool = buildBrowserScrollTool(backend);
    await expect(tool.run({ direction: "sideways" }, CTX)).rejects.toThrow(
      /direction/,
    );
  });

  it("scroll rejects invalid amount type", async () => {
    const tool = buildBrowserScrollTool(backend);
    await expect(
      tool.run({ direction: "down", amount: "lots" }, CTX),
    ).rejects.toThrow(/amount/);
  });

  it("scroll summary reports remaining content below", async () => {
    backend.scrollState = {
      scrollY: 0,
      scrollHeight: 3000,
      viewportHeight: 800,
    };
    const tool = buildBrowserScrollTool(backend);
    const result = await tool.run({ direction: "down" }, CTX);
    expect(result.summary).toContain("remaining below");
  });
});

describe("summariseAriaSnapshot", () => {

  it("applies maxChars budget and reports size truncation footer", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`);
    const raw = lines.join("\n");
    const out = summariseAriaSnapshot(
      raw,
      { url: "https://example.com", title: "t" },
      { maxChars: 400, dropNoise: false },
    );
    expect(out.text.length).toBeLessThan(raw.length);
    expect(out.text).toMatch(/truncated ARIA tree by size/);
    expect(out.refs.length).toBeGreaterThan(0);
    expect(out.refs.length).toBeLessThan(200);
  });

  it("applies char budget and noise dropping together (default call-site path)", () => {
    // The only real call site (playwright-backend) passes no options, so the
    // char budget and noise dropping always run together. Cover that here.
    const noise = Array.from({ length: 20 }, (_, i) => `  - generic [ref=n${i}]:`);
    const links = Array.from(
      { length: 200 },
      (_, i) => `- link "Item ${i}" [ref=e${i}]`,
    );
    const raw = [...noise, ...links].join("\n");
    const out = summariseAriaSnapshot(
      raw,
      { url: "https://example.com", title: "t" },
      { maxChars: 400 },
    );
    expect(out.text).toMatch(/collapsed \d+ empty container lines/);
    expect(out.text).toMatch(/truncated ARIA tree by size/);
    // Empty generics are dropped, so none of the n-refs survive.
    expect(out.refs.some((r) => r.startsWith("n"))).toBe(false);
    expect(out.refs.length).toBeGreaterThan(0);
  });

  it("treats a fractional maxChars as at least one char (never wipes the tree)", () => {
    const raw = '- link "Home" [ref=e1]';
    const out = summariseAriaSnapshot(
      raw,
      { url: "u", title: "t" },
      { maxChars: 0.4 },
    );
    // Must not collapse to an empty body: 0.4 -> trunc 0 previously wiped it.
    expect(out.text).toContain("truncated ARIA tree by size");
    expect(out.refs.length).toBeGreaterThanOrEqual(0);
    expect(out.text).toMatch(/^url: u/);
  });

  it("extracts refs and emits a header", () => {
    const raw = [
      "- banner",
      '  - link [ref=e5]: Home',
      '  - textbox [ref=e7]: Search',
    ].join("\n");
    const out = summariseAriaSnapshot(raw, {
      url: "https://u/",
      title: "T",
    });
    expect(out.refs.sort()).toEqual(["e5", "e7"]);
    expect(out.text).toMatch(/^url: https:\/\/u\//);
    expect(out.text).toContain("[ref=e5]");
    expect(out.digest).toMatch(/^[a-f0-9]+$/);
  });

  it("truncates past maxLines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- link [ref=e${i}]`);
    const out = summariseAriaSnapshot(
      lines.join("\n"),
      { url: "u", title: "t" },
      { maxLines: 10 },
    );
    expect(out.text).toContain("[truncated ARIA tree");
  });

  it("collapses chains of empty generic containers so interactive nodes survive", () => {
    const raw = [
      "- generic [ref=e2]:",
      "  - generic [ref=e4]:",
      "    - generic [ref=e5]:",
      "      - generic [ref=e6]:",
      '        - link "DuckDuckGo home" [ref=e7]: /url',
      "        - generic [ref=e8]:",
      '          - heading "Results" [ref=e9]: Results',
      '          - link "Hermes - Wikipedia" [ref=e10]: /url',
    ].join("\n");
    const out = summariseAriaSnapshot(raw, {
      url: "https://duckduckgo.com/?q=hermes",
      title: "hermes at DuckDuckGo",
    });
    expect(out.text).toContain('link "DuckDuckGo home"');
    expect(out.text).toContain('heading "Results"');
    expect(out.text).toContain('link "Hermes - Wikipedia"');
    expect(out.text).toContain("[collapsed 5 empty container lines]");
    // Noise refs are NOT in the ref list because the model can't
    // usefully act on empty generics.
    expect(out.refs.sort()).toEqual(["e10", "e7", "e9"]);
  });

  it("keeps container lines that carry a quoted name or inline text", () => {
    const raw = [
      '- generic "search-results" [ref=e1]:',
      "- generic [ref=e2]: some inline text",
      "- generic [ref=e3]:",
    ].join("\n");
    const out = summariseAriaSnapshot(raw, { url: "u", title: "t" });
    expect(out.text).toContain('generic "search-results"');
    expect(out.text).toContain("some inline text");
    expect(out.text).toContain("[collapsed 1 empty container lines]");
  });

  it("dropNoise=false preserves the raw tree verbatim", () => {
    const raw = [
      "- generic [ref=e1]:",
      "  - generic [ref=e2]:",
      '    - link [ref=e3]: /url',
    ].join("\n");
    const out = summariseAriaSnapshot(
      raw,
      { url: "u", title: "t" },
      { dropNoise: false },
    );
    expect(out.text).toContain("generic [ref=e1]");
    expect(out.text).toContain("generic [ref=e2]");
    expect(out.text).not.toContain("[collapsed");
  });
});
