/**
 * A tool call whose argument carries the model's own control markup did
 * not come out of the model the way it meant it — and it must not run.
 *
 * Seen live (Gemma 4 31B on llama-server under the GBNF grammar): the
 * first call of a turn was
 * `os.fs.list {"path": ".}}]<tool_call|>thought<|channel>thought---…"}`.
 * The model tried to open another thought channel in the middle of the
 * call; the grammar admits those bytes only inside a JSON string, so the
 * channel markers landed in `path`. The tool ran with the garbage path
 * (`ENAMETOOLONG`), the model read "the folder is empty" and overwrote
 * the user's input file. `findControlMarkers` is what `executeBatch`
 * asks before dispatch; a hit turns the call into an error result the
 * model reads on its next step (see `describeCorruptedCall`).
 *
 * What is NOT flagged: file content that merely mentions a marker. A
 * source file may say `<think>` in a comment mid-line, so for the
 * content arguments of the writing tools (`CONTENT_ARGUMENTS`) only a
 * marker at the START of a line counts — the same line F24's write-time
 * check (`fs-content-check.ts`) draws for transcript markup. Every other
 * string argument (a path, a command, a pattern, a URL, an id) is
 * flagged on any occurrence: none of those has a legitimate reason to
 * carry one.
 */

/**
 * Marker text a model emits only to frame its own output — never as an
 * argument value. Exact strings; the generic `<|name|>` shape is
 * {@link GENERIC_CONTROL_MARKER}.
 */
export const CONTROL_MARKERS: readonly string[] = [
  // Gemma 4: turn framing, the thought channel, tool-call framing. The
  // open form is `<|x>`, the close form `<x|>` (not the `<|x|>` shape).
  "<|channel>",
  "<channel|>",
  "<|turn>",
  "<turn|>",
  "<|tool_call>",
  "<tool_call|>",
  "<|tool_response>",
  "<tool_response|>",
  // Qwen / ChatML: turn delimiters, native tool-call tags, think tags.
  // The think tags are the reasoning prelude's own sentinels — only their
  // appearance INSIDE an argument string is wrong, which is all this
  // module ever looks at.
  "<|im_start|>",
  "<|im_end|>",
  "<tool_call>",
  "</tool_call>",
  "<think>",
  "</think>",
  // Gemma 3: turn delimiters.
  "<start_of_turn>",
  "<end_of_turn>",
];

/**
 * The generic `<|name|>` form (Llama 3 `<|eot_id|>`, Phi `<|assistant|>`,
 * Mistral `<|im_end|>`-alikes): whatever the family, it is a control
 * token, not an argument value.
 */
export const GENERIC_CONTROL_MARKER = /<\|[a-z_]+\|>/;

/**
 * Arguments that carry file content, keyed by tool. A marker there is
 * suspect only at the start of a line: the file may legitimately quote
 * one mid-line, while a line that STARTS with one is transcript markup.
 * `oldString` sits with `newString` because it quotes the file as it is
 * — a line the file already has mid-line must stay editable.
 */
export const CONTENT_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["os.fs.write", new Set(["content"])],
    ["os.fs.edit", new Set(["oldString", "newString"])],
    ["os.fs.patch", new Set(["patch"])],
  ]);

/**
 * Where a file's line starts inside a unified diff: after the one-char
 * `+` / `-` / space prefix of a body line. A bare line start still counts
 * (the prefix is optional), so a corrupted patch is caught either way.
 */
const PATCH_LINE_PREFIX = "[+ -]?";

export interface ControlMarkerHit {
  /** Argument path: `path`, `paths[1]`, `edits[0].newString`. */
  readonly path: string;
  /** The marker text found (for the generic form, the actual token). */
  readonly marker: string;
  /** 0-based char offset of the marker in the argument value. */
  readonly index: number;
  /** A one-line window of the value around the marker, `…` where cut. */
  readonly excerpt: string;
}

const EXCERPT_BEFORE = 8;
const EXCERPT_AFTER = 16;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MARKER_ALTERNATION = [
  ...CONTROL_MARKERS.map(escapeRegExp),
  GENERIC_CONTROL_MARKER.source,
].join("|");

/** A marker anywhere in the value. */
const ANYWHERE = new RegExp(MARKER_ALTERNATION);
/** A marker at the start of a line. */
const LINE_START = new RegExp(`^(?:${MARKER_ALTERNATION})`, "m");
/** A marker at the start of a line of a unified-diff body. */
const PATCH_LINE_START = new RegExp(
  `^${PATCH_LINE_PREFIX}(?:${MARKER_ALTERNATION})`,
  "m",
);

/**
 * Every argument value of `tool`'s call that carries a control marker,
 * one hit per value (the earliest marker), in argument order. Empty
 * when the call is clean. `tool` selects the content arguments that get
 * the line-start rule; without it every string is checked anywhere.
 */
export function findControlMarkers(
  args: Record<string, unknown>,
  tool?: string,
): ControlMarkerHit[] {
  const hits: ControlMarkerHit[] = [];
  const contentKeys = tool !== undefined ? CONTENT_ARGUMENTS.get(tool) : undefined;
  for (const [key, value] of Object.entries(args)) {
    const pattern =
      contentKeys?.has(key) === true
        ? tool === "os.fs.patch"
          ? PATCH_LINE_START
          : LINE_START
        : ANYWHERE;
    walk(value, key, pattern, hits);
  }
  return hits;
}

function walk(
  value: unknown,
  path: string,
  pattern: RegExp,
  hits: ControlMarkerHit[],
): void {
  if (typeof value === "string") {
    const hit = scan(value, pattern);
    if (hit !== null) hits.push({ path, ...hit });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, pattern, hits));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`, pattern, hits);
    }
  }
}

function scan(
  value: string,
  pattern: RegExp,
): Omit<ControlMarkerHit, "path"> | null {
  const match = pattern.exec(value);
  if (match === null) return null;
  // The patch pattern's optional prefix is part of the match; the marker
  // itself starts where the alternation matched.
  const marker = match[0].replace(/^[+ -](?=<)/, "");
  const index = match.index + (match[0].length - marker.length);
  return { marker, index, excerpt: excerptAround(value, index, marker) };
}

function excerptAround(value: string, index: number, marker: string): string {
  const start = Math.max(0, index - EXCERPT_BEFORE);
  const end = Math.min(value.length, index + marker.length + EXCERPT_AFTER);
  const body = value
    .slice(start, end)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `${start > 0 ? "…" : ""}${body}${end < value.length ? "…" : ""}`;
}

/** Hits named in the message before the rest are counted. */
const DESCRIBED_HITS_MAX = 3;

/**
 * The tool result a corrupted call gets instead of running: which
 * argument, which marker, where, and what to do — re-emit the call. The
 * value is quoted only as the short excerpt; the transcript already has
 * the call in full.
 */
export function describeCorruptedCall(
  hits: readonly ControlMarkerHit[],
): string {
  const described = hits
    .slice(0, DESCRIBED_HITS_MAX)
    .map(
      (hit) =>
        `argument \`${hit.path}\` contains a model control marker ` +
        `(\`${hit.marker}\` at char ${hit.index}: "${hit.excerpt}")`,
    );
  const rest = hits.length - described.length;
  const more = rest > 0 ? `; and ${rest} more argument(s)` : "";
  return (
    `corrupted tool call: ${described.join("; ")}${more}. ` +
    "The call was not run — re-emit it with clean arguments."
  );
}
