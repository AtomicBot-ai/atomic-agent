/**
 * Abstract backend that the browser tools depend on. Having this boundary
 * lets us unit-test the tools against a deterministic fake backend without
 * launching Chrome, and keeps room for non-Playwright backends later.
 *
 * Element references are opaque strings (e.g. `e12`) produced by
 * Playwright's AI-mode aria snapshot; the backend resolves them through the
 * `aria-ref=<id>` locator.
 */

export interface AriaSnapshot {
  url: string;
  title: string;
  /** Human-readable, ref-tagged snapshot text ready for prompt injection. */
  text: string;
  /** Short deterministic digest over (url, text); cheap to compare between steps. */
  digest: string;
  /** Set of ref ids referenced in `text`. */
  refs: string[];
  /**
   * URL of every frame on the page. The ARIA text includes iframe
   * content (cross-origin too), so the domain lists check these as well.
   */
  frameUrls?: string[];
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface NavigateInput {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

export interface ClickInput {
  ref: string;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
}

export interface TypeInput {
  ref: string;
  text: string;
  pressEnter?: boolean;
  clearFirst?: boolean;
}

export interface TabsInput {
  action: "list" | "switch" | "close" | "new";
  index?: number;
  url?: string;
}

export interface SearchInput {
  query: string;
  engine?: "google" | "duckduckgo" | "bing";
}

export type ScrollDirection = "up" | "down" | "top" | "bottom";

export interface ScrollInput {
  direction: ScrollDirection;
  /**
   * `"page"` (default) scrolls by a full viewport, `"half"` by half of
   * one. A numeric value is interpreted as raw pixels, positive = down,
   * ignored for `"top"`/`"bottom"`.
   */
  amount?: "page" | "half" | number;
}

export interface ScrollResult {
  /** Scroll position after the action, in CSS pixels from the top. */
  scrollY: number;
  /** Document scroll height for context (how much more is below). */
  scrollHeight: number;
  /** Viewport inner height used for page/half amounts. */
  viewportHeight: number;
}

/**
 * Facts about one ref'd element, read before `browser.click` /
 * `browser.type` so the approval gate can tell a plain link from a
 * submit, delete or password field (`classify-browser-action.ts`).
 * Strings are trimmed and capped; never contains a field's value.
 */
export interface RefDescription {
  /**
   * Lowercased tag of the effective control: the nearest enclosing
   * button / link / submit / menu item / tab, else the element itself.
   */
  tag: string;
  /** Lowercased tag of the ref'd element itself (an `svg` inside a button). */
  targetTag: string;
  /** Explicit `role` attribute, lowercased, or `null`. */
  role: string | null;
  /** Accessible name approximation: aria-label, label, text, title. */
  name: string;
  /** Lowercased `type` attribute, or `null`. */
  type: string | null;
  /** Lowercased `autocomplete` attribute, or `null`. */
  autocomplete: string | null;
  /** Lowercased name / id / placeholder / label words for field heuristics. */
  fieldHints: string;
  /** An `<input>`, `<textarea>` or contenteditable element. */
  editable: boolean;
  /** Inside (or owned by) a `<form>`. */
  inForm: boolean;
  formAction: string | null;
  formMethod: string | null;
  /** Inside a search form or `role=search` landmark. */
  inSearchForm: boolean;
  /** Submits its form when clicked (default-type button in a form, input submit/image). */
  isSubmit: boolean;
  /** `href` of a link, or `null`. */
  href: string | null;
  /** URL of the frame the element is in (the page URL outside iframes). */
  pageUrl: string;
}

export interface BrowserBackend {
  /** Lazy init; must be safe to call multiple times. */
  ensureReady(): Promise<void>;
  /** Tear down (close the persistent context / disconnect CDP). */
  shutdown(): Promise<void>;

  snapshot(options?: { depth?: number; full?: boolean }): Promise<AriaSnapshot>;
  /**
   * Cheap synchronous-ish check: does the current DOM carry an
   * `aria-ref=<ref>` attribute? Used by tools that act on refs (click,
   * type) to fail fast with a clear message when a previous navigation
   * or re-snapshot invalidated the ref the model is trying to use,
   * instead of letting the mutating locator wait out its default
   * timeout.
   */
  hasRef(ref: string): Promise<boolean>;
  /**
   * Describe the element behind `ref` for the click / type approval
   * gate, or `null` when it cannot be found. May throw; callers treat a
   * throw like `null` (fail closed: the action asks).
   */
  describeRef(ref: string): Promise<RefDescription | null>;
  /** URL of the active page; the domain lists re-check it after an action. */
  currentUrl(): Promise<string>;

  navigate(input: NavigateInput): Promise<{ url: string; title: string }>;
  click(input: ClickInput): Promise<{ clickedRef: string }>;
  type(input: TypeInput): Promise<{ typedLength: number }>;
  search(input: SearchInput): Promise<{ url: string }>;
  tabs(input: TabsInput): Promise<{ tabs: TabInfo[] }>;
  /**
   * Scroll the active page. Does NOT automatically take a new ARIA
   * snapshot — the caller decides whether the next action requires a
   * fresh world read. This keeps the "one step, one effect" invariant.
   */
  scroll(input: ScrollInput): Promise<ScrollResult>;
}
