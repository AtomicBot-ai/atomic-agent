/**
 * Abstract backend that the browser tools depend on. Having this boundary
 * lets us unit-test the tools against a deterministic fake backend without
 * launching Chrome, and keeps room for non-Playwright backends later.
 *
 * Element references are opaque strings (e.g. `e12`) produced by
 * Playwright's AI-mode aria snapshot; the backend resolves them through the
 * `aria-ref=<id>` locator.
 */

import type { PageDebugLog } from "./page-debug-log.js";

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
  /**
   * `new` only: browse from now on in the agent's profile (`"agent"`) or
   * in this session's own throwaway, logged-out one (`"temp"`, ATO-959).
   */
  profile?: "agent" | "temp";
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

export interface ScreenshotInput {
  /** Shoot only this element (a ref from the latest snapshot). */
  ref?: string;
  /** The whole scrollable page instead of the viewport (capped in height). */
  fullPage?: boolean;
  /** Long side of the image in pixels; the backend never upscales. */
  maxSide: number;
  /** JPEG quality, 1–100. */
  quality: number;
}

export interface ScreenshotResult {
  buffer: Buffer;
  width: number;
  height: number;
  mime: "image/jpeg";
  /** Page the pixels came from, read right after the capture. */
  url: string;
  title: string;
  /**
   * URL of every frame on the page, read before and after the capture,
   * so the caller can refuse a shot that shows a blocked site in an
   * iframe or that raced a redirect.
   */
  frameUrls: string[];
  /** A full-page shot was cut at the height cap (`screenshot-geometry.ts`). */
  clipped: boolean;
}

/**
 * One `browser.act` step (ATO-957): thin Playwright wrappers kept behind
 * a single tool so the tool list and grammar stay small. Arguments are
 * validated by `page-action-args.ts`; the approval gate runs in `act.ts`
 * before the backend sees any of these.
 */
export type PageActionInput =
  | { action: "select"; ref: string; values: string[] }
  | { action: "upload"; ref: string; paths: string[] }
  | { action: "back" }
  | { action: "forward" }
  | { action: "key"; key: string; ref?: string }
  | { action: "hover"; ref: string }
  /** Answer the next JS dialog (alert / confirm / prompt) on the active tab. */
  | { action: "dialog"; accept: boolean; text?: string }
  | { action: "wait"; ms: number }
  | { action: "wait"; text: string; state: "visible" | "hidden"; timeoutMs: number }
  | { action: "wait"; ref: string; state: "visible" | "hidden"; timeoutMs: number };

export type PageActionName = PageActionInput["action"];

export interface PageActionResult {
  /** `false` when the step ran but did not happen (no history, a wait that timed out). */
  done: boolean;
  /** One short line for the model ("went back", "selected 2 options"). */
  note: string;
}

/** What `listSiteTools` reads from the page; nothing here is trusted or capped yet. */
export interface SiteToolsListInput {
  /** At most this many declared tools are read from the page. */
  maxScan: number;
  maxSchemaChars: number;
  maxDescriptionChars: number;
}

export interface SiteToolsListing {
  /** The page the tools came from (its main frame), read with the list. */
  url: string;
  frameUrls: string[];
  /** Raw entries as the page gave them; `site-tools-sanitize.ts` checks them. */
  tools: unknown[];
  /** How many tools the page declared in all, before `maxScan`. */
  total: number;
}

export interface SiteToolCallInput {
  name: string;
  /** The arguments as JSON, already checked against the declared schema. */
  argsJson: string;
  timeoutMs: number;
  maxResultChars: number;
  /**
   * The host the call was approved for (normalised, no port). The page
   * refuses to run the tool when it is on another host by then.
   */
  host?: string;
}

export interface SiteToolCallResult {
  url: string;
  frameUrls: string[];
  ok: boolean;
  /** The tool's answer as text (MCP-style `content` text joined), capped. */
  text: string;
  /** The tool said its own call failed (`isError` in an MCP-style result). */
  isError: boolean;
  /** Why the call did not run or finish: `not_found`, `timeout`, `threw`, `bad_args`, `wrong_host`. */
  error?: string;
  /** The page's own error message, when it threw (site text, untrusted). */
  message?: string;
}

export interface RenderHtmlInput {
  url: string;
  /** Overall budget for loading the page and waiting out a wall. */
  timeoutMs: number;
  /**
   * Polled with the page HTML once it has loaded: `true` means the page
   * is still a bot-protection interstitial, so the backend waits a second
   * and reads again until `timeoutMs` runs out.
   */
  isStillWalled?: (html: string) => boolean;
}

export interface RenderHtmlResult {
  /** Where the page ended up after redirects and challenge reloads. */
  url: string;
  title: string;
  /** Serialised DOM after JavaScript ran (`page.content()`). */
  html: string;
  /** URL of every frame, so the caller can apply the domain lists. */
  frameUrls: string[];
}

export interface AnnotateStartResult {
  /** Page the overlay is on. */
  url: string;
  /** False when the overlay was already on the page (picking resumed). */
  started: boolean;
  /** Pins already placed. */
  pins: number;
}

export interface AnnotateReadInput {
  /** Take a JPEG of each pinned element as well. */
  crops: boolean;
  maxCrops: number;
  /** A crop over this many bytes is dropped. */
  maxCropBytes: number;
}

export interface AnnotationCrop {
  pinId: number;
  buffer?: Buffer;
  /** Why there is no picture: `too_large`, `not_visible`, `failed`. */
  skipped?: string;
}

export interface AnnotateReadResult {
  url: string;
  frameUrls: string[];
  /** An overlay was started in this document (a navigation drops it). */
  active: boolean;
  /** The user can still add pins (they have not pressed Done). */
  picking: boolean;
  /** Raw pins as the overlay gave them; `annotate-pins.ts` checks them. */
  pins: unknown[];
  crops: AnnotationCrop[];
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
  /**
   * JPEG of the active page: its viewport, the full page or one element.
   * The values of card-number / one-time-code fields are drawn as dots
   * for the capture (passwords already are). Never written to disk here.
   */
  screenshot(input: ScreenshotInput): Promise<ScreenshotResult>;
  /**
   * Select, upload, back / forward, key press, hover, dialog answer and
   * wait (`browser.act`). Optional so test fakes that do not need it
   * stay valid; the tool reports "not supported" when it is missing.
   */
  act?(input: PageActionInput): Promise<PageActionResult>;
  /**
   * Tools the active page declared through WebMCP (`document.modelContext`
   * / `navigator.modelContext`, ATO-521), main frame only. Optional: a
   * backend without it has no site tools.
   */
  listSiteTools?(input: SiteToolsListInput): Promise<SiteToolsListing>;
  /** Run one of those tools in the page. Never asks; the tool gates it. */
  callSiteTool?(input: SiteToolCallInput): Promise<SiteToolCallResult>;
  /**
   * Load `url` in a throwaway tab of the agent's own browser, return the
   * rendered HTML and close the tab (ATO-968, `os.web.fetch` past a bot
   * wall). The tab never becomes the model's active page. Optional: a
   * backend without it (or the user's own Chrome) is skipped by the
   * fetch ladder.
   */
  renderHtml?(input: RenderHtmlInput): Promise<RenderHtmlResult>;
  /**
   * Recent console messages, page errors and requests of the pages the
   * agent can see (`browser.debug`, ATO-701), recorded from the moment
   * the browser was attached. Optional: a backend without it makes the
   * tool say so.
   */
  debugLog?(): PageDebugLog;
  /**
   * Annotate mode (ATO-518): put the pin overlay on the active page so the
   * user can click elements and comment on them, read the pins back, or
   * take the overlay off. Optional: a backend without it cannot annotate.
   */
  startAnnotate?(): Promise<AnnotateStartResult>;
  readAnnotations?(input: AnnotateReadInput): Promise<AnnotateReadResult>;
  /** Resolves the number of pins dropped. */
  stopAnnotate?(): Promise<{ url: string; removed: number }>;
  /**
   * Take over (ATO-508): get the calling session's active tab ready for
   * the person to act in by hand. The agent's own Chrome that runs
   * without a window is restarted with one (`browser.headless: "auto"`),
   * then the tab is brought to the front. Optional: a backend without it
   * cannot hand over.
   */
  prepareTakeOver?(): Promise<TakeOverTarget>;
}

/** The tab the person is handed (`BrowserBackend.prepareTakeOver`). */
export interface TakeOverTarget {
  url: string;
  title: string;
  /**
   * False when nobody can see the tab: the agent's Chrome is headless
   * and `browser.headless` is `true`, so it is never given a window.
   */
  window: boolean;
}
