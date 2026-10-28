import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  RefDescription,
  ScreenshotInput,
  ScreenshotResult,
  TabInfo,
  TypeInput,
} from "./browser-backend.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";

/**
 * Shared fakes for the browser gate tests (browser-approval-gate.test.ts,
 * browser-domain-gate.test.ts). Test-only: production never imports it.
 */

export const GATE_CTX: {
  workingDir: string;
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
} = {
  workingDir: "/tmp",
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
};

export function facts(over: Partial<RefDescription> = {}): RefDescription {
  return {
    tag: "a",
    targetTag: "a",
    role: null,
    name: "Learn more",
    type: null,
    autocomplete: null,
    fieldHints: "",
    editable: false,
    inForm: false,
    formAction: null,
    formMethod: null,
    inSearchForm: false,
    isSubmit: false,
    href: "/docs",
    pageUrl: "https://shop.example/cart",
    ...over,
  };
}

/**
 * A backend whose active page has a URL: `navigate` moves it (through
 * `redirects` when the asked-for URL has an entry), `currentUrl` and
 * `snapshot` report it.
 */
export class GateBackend implements BrowserBackend {
  public clicks: ClickInput[] = [];
  public types: TypeInput[] = [];
  public navigations: NavigateInput[] = [];
  public tabCalls = 0;
  public searches = 0;
  public snapshots = 0;
  public element: RefDescription | null = facts();
  public describeThrows = false;
  public url = "https://shop.example/cart";
  /** Where a URL ends up after redirects; also where a click / Enter lands. */
  public redirects = new Map<string, string>();
  public landAfterAction: string | null = null;

  async ensureReady(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async snapshot(): Promise<AriaSnapshot> {
    this.snapshots += 1;
    return { url: this.url, title: "Page", text: "- secret page text [ref=e1]", digest: "d", refs: ["e1"] };
  }
  async hasRef(): Promise<boolean> {
    return true;
  }
  async describeRef(): Promise<RefDescription | null> {
    if (this.describeThrows) throw new Error("evaluate timed out");
    return this.element;
  }
  async currentUrl(): Promise<string> {
    return this.url;
  }
  async navigate(input: NavigateInput): Promise<{ url: string; title: string }> {
    this.navigations.push(input);
    this.url = this.redirects.get(input.url) ?? input.url;
    return { url: this.url, title: "t" };
  }
  async click(input: ClickInput): Promise<{ clickedRef: string }> {
    this.clicks.push(input);
    if (this.landAfterAction !== null) this.url = this.landAfterAction;
    return { clickedRef: input.ref };
  }
  async type(input: TypeInput): Promise<{ typedLength: number }> {
    this.types.push(input);
    if (input.pressEnter && this.landAfterAction !== null) this.url = this.landAfterAction;
    return { typedLength: input.text.length };
  }
  async search(): Promise<{ url: string }> {
    this.searches += 1;
    this.url = "https://www.google.com/search?q=x";
    return { url: this.url };
  }
  async tabs(): Promise<{ tabs: TabInfo[] }> {
    this.tabCalls += 1;
    return { tabs: [] };
  }
  async scroll(): Promise<{ scrollY: number; scrollHeight: number; viewportHeight: number }> {
    return { scrollY: 0, scrollHeight: 0, viewportHeight: 800 };
  }
  public shots: ScreenshotInput[] = [];
  /** Bytes per capture attempt (the last entry repeats); frame URLs reported with the shot. */
  public shotBytes: number[] = [1_000];
  public shotFrames: string[] = [];
  /** Where the page is once the capture is taken (a racing redirect). */
  public landDuringShot: string | null = null;
  async screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    this.shots.push(input);
    const size = this.shotBytes[Math.min(this.shots.length - 1, this.shotBytes.length - 1)]!;
    if (this.landDuringShot !== null) this.url = this.landDuringShot;
    return {
      buffer: Buffer.alloc(size, 1),
      width: input.maxSide,
      height: Math.round(input.maxSide * 0.6),
      mime: "image/jpeg",
      url: this.url,
      title: "Page",
      frameUrls: [this.url, ...this.shotFrames],
      clipped: false,
    };
  }
}

/** A gate that answers every request the same way and records the prompts. */
export function recordingGate(approved: boolean): {
  prompts: Array<Record<string, unknown>>;
  options: DangerousToolOptions;
} {
  const prompts: Array<Record<string, unknown>> = [];
  const request = async (req: Record<string, unknown>) => {
    prompts.push(req);
    return approved ? { approved: true } : { approved: false, reason: "no" };
  };
  return {
    prompts,
    options: { approvals: { request } as unknown as ApprovalGate, approvalRequired: true },
  };
}
