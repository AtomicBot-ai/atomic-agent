import { packLinesToCharBudget } from "./aria-compressor.js";

/**
 * Compact views of a ref-tagged ARIA snapshot (ATO-956).
 *
 * The full tree is a few thousand tokens per step; a 4–9B local model
 * drowns in it. These views cut the same snapshot text down without
 * renumbering anything: every `eN` shown is the id Playwright put in the
 * text, so `browser.click` / `browser.type` resolve it exactly as they
 * would from the full tree.
 *
 *  - `interactiveView`: one line per ref'd control, grouped under the
 *    nearest landmark / heading.
 *  - `regionView`: the subtree under one ref.
 *  - `diffView`: what changed by ref since the previous snapshot of the
 *    same page.
 *
 * Pure functions over the text; no backend, no I/O.
 */

/** Roles the model can act on with click / type. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
]);

/** Roles that name a region of the page; used as group headers. */
const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "form",
  "search",
  "region",
  "dialog",
  "alertdialog",
]);

/** Containers that carry nothing on their own (mirrors aria-compressor). */
const NOISE_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "group",
  "none",
  "presentation",
  "paragraph",
]);

/** State flags worth keeping on a compact line; the rest (cursor=…, ref) is dropped. */
const KEPT_FLAGS = /^(checked|checked=mixed|disabled|expanded|selected|pressed|pressed=mixed|required|invalid)$/;

const MAX_NAME_CHARS = 80;
const MAX_INLINE_CHARS = 60;

export interface AriaNode {
  /** Index of the line in the snapshot body. */
  index: number;
  indent: number;
  role: string;
  name: string | null;
  ref: string | null;
  flags: string[];
  /** Text after the trailing colon, trimmed; "" when none. */
  inline: string;
  raw: string;
}

export interface SplitSnapshot {
  url: string;
  title: string;
  /** Lines after the header, footer lines (`… [...]`) removed. */
  body: string[];
}

const NODE_PATTERN = /^-\s+([A-Za-z][A-Za-z0-9_-]*)(.*)$/;
const QUOTED_NAME = /^\s+"((?:[^"\\]|\\.)*)"/;
const FLAG = /^\s*\[([^\]]*)\]/;

/** Parse one tree line, or `null` for text / url / property lines. */
export function parseAriaNode(raw: string, index = 0): AriaNode | null {
  const indent = raw.length - raw.trimStart().length;
  const match = NODE_PATTERN.exec(raw.slice(indent));
  if (!match) return null;
  const role = match[1]!;
  let rest = match[2]!;
  let name: string | null = null;
  const nameMatch = QUOTED_NAME.exec(rest);
  if (nameMatch) {
    name = nameMatch[1]!.replace(/\\(.)/g, "$1");
    rest = rest.slice(nameMatch[0].length);
  }
  let ref: string | null = null;
  const flags: string[] = [];
  for (let flag = FLAG.exec(rest); flag; flag = FLAG.exec(rest)) {
    const value = flag[1]!.trim();
    const refMatch = /^ref=([A-Za-z0-9]+)$/.exec(value);
    if (refMatch) ref = refMatch[1]!;
    else flags.push(value);
    rest = rest.slice(flag[0].length);
  }
  rest = rest.trim();
  const inline = rest.startsWith(":") ? rest.slice(1).trim() : "";
  return { index, indent, role, name, ref, flags, inline, raw };
}

/** Separate the `url:` / `title:` header and the compressor footer from the tree. */
export function splitSnapshotText(text: string): SplitSnapshot {
  const lines = text.split(/\r?\n/);
  let url = "";
  let title = "";
  let start = 0;
  if (lines[0]?.startsWith("url: ")) {
    url = lines[0].slice(5);
    start = 1;
    if (lines[1]?.startsWith("title: ")) {
      title = lines[1].slice(7);
      start = 2;
    }
    if (lines[start] === "") start += 1;
  }
  const body = lines
    .slice(start)
    .filter((line) => !/^…\s\[/.test(line) && line.trim().length > 0);
  return { url, title, body };
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `[e12] button "Send" [disabled]` — one compact line per ref'd node. */
export function renderCompactNode(node: AriaNode): string {
  const parts = [`[${node.ref ?? "?"}]`, node.role];
  if (node.name !== null && node.name.length > 0) {
    parts.push(JSON.stringify(clip(node.name, MAX_NAME_CHARS)));
  }
  for (const flag of node.flags) {
    if (KEPT_FLAGS.test(flag)) parts.push(`[${flag}]`);
  }
  let line = parts.join(" ");
  if (node.inline.length > 0 && !node.inline.startsWith("/url")) {
    const inline = clip(node.inline, MAX_INLINE_CHARS);
    if (inline !== node.name) line += `: ${inline}`;
  }
  return line;
}

/** `navigation "Primary" [e4]`: the ref lets the model ask for that region. */
function landmarkLabel(node: AriaNode): string {
  const base = node.name ? `${node.role} ${JSON.stringify(clip(node.name, 40))}` : node.role;
  return node.ref ? `${base} [${node.ref}]` : base;
}

interface Frame {
  indent: number;
  label: string | null;
  heading: string | null;
}

export interface CompactView {
  /** View text with the url/title header, ready for `### world`. */
  text: string;
  /** Refs shown in the view. */
  refs: string[];
  /** True when the char budget cut lines off. */
  truncated: boolean;
}

function header(url: string, title: string, mode: string): string[] {
  return [`url: ${url}`, `title: ${title}`, `view: ${mode}`, ""];
}

function finish(
  head: string[],
  lines: string[],
  maxChars: number,
  footerNote: string | null,
): CompactView {
  const packed = packLinesToCharBudget(lines, maxChars);
  const footer: string[] = [];
  if (packed.truncated) {
    footer.push(
      `… [${lines.length - packed.lines.length} more lines over the size budget — use read_aria mode "region" with a ref, or scroll]`,
    );
  }
  if (footerNote) footer.push(footerNote);
  const refs = Array.from(
    new Set(
      packed.lines.flatMap((line) => {
        const m = /^\s*[+~-]?\s*\[([A-Za-z0-9]+)\]/.exec(line);
        return m ? [m[1]!] : [];
      }),
    ),
  );
  return {
    text: [...head, ...packed.lines, ...footer].join("\n").trimEnd(),
    refs,
    truncated: packed.truncated,
  };
}

/** The ref'd interactive controls, each tagged with its group header. */
export function interactiveEntries(
  body: readonly string[],
): Array<{ group: string; node: AriaNode }> {
  const out: Array<{ group: string; node: AriaNode }> = [];
  const root: Frame = { indent: -1, label: null, heading: null };
  const stack: Frame[] = [root];
  body.forEach((raw, index) => {
    const node = parseAriaNode(raw, index);
    if (!node) return;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= node.indent) {
      stack.pop();
    }
    if (LANDMARK_ROLES.has(node.role)) {
      stack.push({ indent: node.indent, label: landmarkLabel(node), heading: null });
      return;
    }
    const scope = stack[stack.length - 1]!;
    if (node.role === "heading") {
      const text = node.name ?? node.inline;
      if (text) scope.heading = clip(text, 60);
      return;
    }
    if (node.ref === null || !INTERACTIVE_ROLES.has(node.role)) return;
    const landmark = [...stack].reverse().find((f) => f.label !== null)?.label ?? null;
    const group = [landmark, scope.heading].filter((p) => p !== null).join(" › ");
    out.push({ group, node });
  });
  return out;
}

/**
 * Only the controls: one line per ref'd interactive element, under
 * `## <landmark> › <heading>` headers that appear when the group changes.
 */
export function interactiveView(text: string, maxChars: number): CompactView {
  const split = splitSnapshotText(text);
  const entries = interactiveEntries(split.body);
  const lines: string[] = [];
  let currentGroup: string | null = null;
  for (const { group, node } of entries) {
    if (group !== currentGroup) {
      if (group.length > 0) lines.push(`## ${group}`);
      currentGroup = group;
    }
    lines.push(renderCompactNode(node));
  }
  if (entries.length === 0) lines.push("(no interactive elements with refs on this page)");
  return finish(
    header(split.url, split.title, "interactive"),
    lines,
    maxChars,
    `… [${entries.length} controls of ${split.body.length} tree lines; page text hidden — read_aria mode "full" or "region" to read it]`,
  );
}

/** The subtree under `ref`, noise containers dropped; `null` when the ref is absent. */
export function regionView(text: string, ref: string, maxChars: number): CompactView | null {
  const split = splitSnapshotText(text);
  const startIdx = split.body.findIndex((line) => parseAriaNode(line)?.ref === ref);
  if (startIdx < 0) return null;
  const rootIndent = split.body[startIdx]!.length - split.body[startIdx]!.trimStart().length;
  const lines: string[] = [split.body[startIdx]!.slice(rootIndent)];
  for (let i = startIdx + 1; i < split.body.length; i += 1) {
    const line = split.body[i]!;
    const indent = line.length - line.trimStart().length;
    if (indent <= rootIndent) break;
    const node = parseAriaNode(line);
    if (node && NOISE_ROLES.has(node.role) && !node.name && node.inline.length === 0) continue;
    lines.push(line.slice(rootIndent));
  }
  const view = finish(header(split.url, split.title, `region ${ref}`), lines, maxChars, null);
  return { ...view, refs: refsIn(view.text) };
}

function refsIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\[ref=([A-Za-z0-9]+)\]/g), (m) => m[1]!)));
}

/** Every ref'd node that says something, keyed by ref, rendered compactly. */
export function refIndex(body: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  body.forEach((raw, index) => {
    const node = parseAriaNode(raw, index);
    if (!node || node.ref === null) return;
    if (NOISE_ROLES.has(node.role) && !node.name && node.inline.length === 0) return;
    out.set(node.ref, renderCompactNode(node));
  });
  return out;
}

export interface PreviousSnapshot {
  url: string;
  text: string;
}

/**
 * Changes by ref against the previous snapshot of the same tab:
 * `+` added, `-` removed, `~` changed (new rendering, old after `was:`).
 * Falls back to the interactive view when there is no previous snapshot
 * or the URL changed — the old refs mean nothing on a new page.
 */
export function diffView(
  previous: PreviousSnapshot | undefined,
  text: string,
  maxChars: number,
): CompactView & { fellBack: boolean } {
  const split = splitSnapshotText(text);
  if (!previous || previous.url !== split.url) {
    const reason = previous ? "the URL changed" : "no earlier snapshot of this tab";
    const view = interactiveView(text, maxChars);
    return {
      ...view,
      text: view.text.replace("view: interactive", `view: interactive (diff unavailable: ${reason})`),
      fellBack: true,
    };
  }
  const before = refIndex(splitSnapshotText(previous.text).body);
  const after = refIndex(split.body);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [ref, line] of after) {
    const old = before.get(ref);
    if (old === undefined) added.push(`+ ${line}`);
    else if (old !== line) changed.push(`~ ${line}  (was: ${old.replace(/^\[[^\]]+\]\s*/, "")})`);
  }
  for (const [ref, line] of before) {
    if (!after.has(ref)) removed.push(`- ${line}`);
  }
  const lines = [...added, ...changed, ...removed];
  if (lines.length === 0) lines.push("(no changes since the previous snapshot)");
  const view = finish(
    header(split.url, split.title, "diff"),
    lines,
    maxChars,
    `… [${added.length} added, ${changed.length} changed, ${removed.length} removed; "-" refs are gone — do not use them]`,
  );
  // A removed ref is shown so the model stops using it, but it is not a live ref.
  return { ...view, refs: view.refs.filter((ref) => after.has(ref)), fellBack: false };
}
