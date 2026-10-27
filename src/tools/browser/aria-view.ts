import { createHash } from "node:crypto";
import { DEFAULT_ARIA_MAX_CHARS, packLinesToCharBudget } from "./aria-compressor.js";
import type { AriaSnapshot, BrowserBackend } from "./browser-backend.js";
import {
  checkBrowserUrl,
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import {
  diffView,
  interactiveView,
  regionView,
  type PreviousSnapshot,
} from "./compact-aria.js";

/**
 * Which page view reaches the model (ATO-956), how big it may be, and the
 * per-tab memory the `diff` view compares against.
 *
 * Default: a small context window (≤ 32k tokens) or a local model gets
 * `interactive`; everything else gets `full`, as before. The char budget
 * is 4% of the window at ~4 chars per token, clamped to 2k–24k chars.
 */

export const ARIA_VIEW_MODES = ["full", "interactive", "diff", "region"] as const;
export type AriaViewMode = (typeof ARIA_VIEW_MODES)[number];

/** At or below this window the full tree crowds out the task. */
export const SMALL_CONTEXT_TOKENS = 32_768;
export const MIN_ARIA_VIEW_CHARS = 2_000;
const BUDGET_SHARE = 0.04;
const CHARS_PER_TOKEN = 4;

/** What a tool knows about the model it is serving. */
export interface AriaViewContext {
  modelMode?: "local" | "cloud";
  /** Context window of the model serving the step, when known. */
  contextWindowTokens?: number;
  sessionId?: string;
}

function knownWindow(tokens: number | undefined): number | null {
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/** Char budget for one view: 4% of the window × 4 chars, clamped 2k–24k. */
export function ariaCharBudget(contextWindowTokens?: number): number {
  const window = knownWindow(contextWindowTokens);
  if (window === null) return DEFAULT_ARIA_MAX_CHARS;
  const chars = Math.round(window * BUDGET_SHARE * CHARS_PER_TOKEN);
  return Math.min(DEFAULT_ARIA_MAX_CHARS, Math.max(MIN_ARIA_VIEW_CHARS, chars));
}

/** `interactive` for a small window or a local model, else `full`. */
export function defaultAriaViewMode(view: AriaViewContext): "full" | "interactive" {
  if (view.modelMode === "local") return "interactive";
  const window = knownWindow(view.contextWindowTokens);
  if (window !== null && window <= SMALL_CONTEXT_TOKENS) return "interactive";
  return "full";
}

/** Parse the `mode` arg; `null`/absent ⇒ default, anything else ⇒ error text. */
export function parseAriaViewMode(value: unknown): AriaViewMode | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && (ARIA_VIEW_MODES as readonly string[]).includes(value)) {
    return value as AriaViewMode;
  }
  return { error: `\`mode\` must be one of ${ARIA_VIEW_MODES.map((m) => `"${m}"`).join(", ")}` };
}

/**
 * Last snapshot per session + tab, for the `diff` view. Keeps one entry
 * per key and at most `maxEntries` keys (least recently used goes first),
 * so a long browsing session holds a handful of trees, not all of them.
 */
export class AriaSnapshotStore {
  private readonly entries = new Map<string, PreviousSnapshot>();
  constructor(private readonly maxEntries = 8) {}

  get(key: string): PreviousSnapshot | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: PreviousSnapshot): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface RenderedAriaView {
  mode: AriaViewMode;
  text: string;
  digest: string;
  refs: string[];
  /** Set when the asked view could not be served as asked. */
  note?: string;
}

function digestOf(url: string, text: string): string {
  return createHash("sha1").update(`${url}\n${text}`).digest("hex").slice(0, 12);
}

/**
 * Turn one snapshot into the view the model sees. `full` keeps the
 * backend's text (and digest) unless a context budget is given and the
 * text is over it. Pure: no backend, no store writes.
 */
export function renderAriaView(input: {
  snapshot: AriaSnapshot;
  mode: AriaViewMode;
  maxChars: number;
  ref?: string;
  previous?: PreviousSnapshot;
  /** Apply `maxChars` to the full view too (off for cloud: it asked for the whole tree). */
  budgetFull?: boolean;
}): RenderedAriaView | { error: string } {
  const { snapshot, maxChars } = input;
  const done = (mode: AriaViewMode, view: { text: string; refs: string[] }, note?: string): RenderedAriaView => ({
    mode,
    text: view.text,
    refs: view.refs,
    digest: digestOf(snapshot.url, view.text),
    ...(note ? { note } : {}),
  });
  switch (input.mode) {
    case "interactive":
      return done("interactive", interactiveView(snapshot.text, maxChars));
    case "diff": {
      const view = diffView(input.previous, snapshot.text, maxChars);
      return view.fellBack
        ? done("interactive", view, "no comparable earlier snapshot of this tab; showing the interactive view")
        : done("diff", view);
    }
    case "region": {
      if (!input.ref) return { error: '`ref` is required with mode "region"' };
      const view = regionView(snapshot.text, input.ref, maxChars);
      if (!view) {
        return { error: `ref '${input.ref}' is not on the current page — call browser.read_aria for fresh refs` };
      }
      return done("region", view);
    }
    case "full": {
      if (!input.budgetFull || snapshot.text.length <= maxChars) {
        return { mode: "full", text: snapshot.text, digest: snapshot.digest, refs: snapshot.refs };
      }
      const lines = snapshot.text.split("\n");
      const packed = packLinesToCharBudget(lines, maxChars);
      const text = [
        ...packed.lines,
        `… [truncated to ~${maxChars} chars for this model's context — read_aria mode "region" with a ref for one part]`,
      ].join("\n");
      const refs = Array.from(new Set(Array.from(text.matchAll(/\[ref=([A-Za-z0-9]+)\]/g), (m) => m[1]!)));
      return done("full", { text, refs });
    }
  }
}

export type ReadAriaViewResult =
  | { kind: "blocked"; host: string }
  | { kind: "error"; message: string }
  | { kind: "ok"; snapshot: AriaSnapshot; view: RenderedAriaView };

async function tabKey(backend: BrowserBackend, sessionId: string): Promise<string> {
  try {
    const { tabs } = await backend.tabs({ action: "list" });
    const active = tabs.find((t) => t.active);
    return `${sessionId}#${active?.index ?? 0}`;
  } catch {
    return `${sessionId}#0`;
  }
}

/**
 * Snapshot the active page and render the requested (or default) view.
 * Compact views read the whole tree (`full: true`) so no control is lost
 * to the backend's own size cut before filtering. A blocked page is
 * refused before anything is rendered or remembered.
 */
export async function readAriaView(
  backend: BrowserBackend,
  request: { mode?: AriaViewMode; ref?: string; depth?: number },
  view: AriaViewContext,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  store?: AriaSnapshotStore,
): Promise<ReadAriaViewResult> {
  const mode = request.mode ?? defaultAriaViewMode(view);
  const cloud = view.modelMode === "cloud";
  const wantsWholeTree = mode !== "full" || cloud;
  const snapshot = await backend.snapshot({
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(wantsWholeTree ? { full: true } : {}),
  });
  const verdict = checkBrowserUrl(snapshot.url, policy);
  if (verdict.kind === "blocked") return { kind: "blocked", host: verdict.host };
  const key = store && view.sessionId !== undefined ? await tabKey(backend, view.sessionId) : null;
  const rendered = renderAriaView({
    snapshot,
    mode,
    maxChars: ariaCharBudget(view.contextWindowTokens),
    ...(request.ref !== undefined ? { ref: request.ref } : {}),
    ...(store && key !== null ? { previous: store.get(key) } : {}),
    budgetFull: !cloud && knownWindow(view.contextWindowTokens) !== null,
  });
  if ("error" in rendered) return { kind: "error", message: rendered.error };
  if (store && key !== null) store.set(key, { url: snapshot.url, text: snapshot.text });
  return { kind: "ok", snapshot, view: rendered };
}
