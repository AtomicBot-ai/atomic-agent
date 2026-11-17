/**
 * ATO-1157 — what a Claude Code or Codex session is doing right now, read
 * off the end of its transcript (agent-hub-scan.ts reads the bytes).
 *
 *   waiting  the person has to act: a tool call waits for approval, the
 *            agent replied and the turn is theirs, or it stopped on an error
 *            (a usage limit, say — the case "Continue here" exists for)
 *   running  the file moved in the last few seconds and the turn is not over
 *   idle     anything else: interrupted, finished long ago, gone quiet
 *
 * Only the transcript is read, so this is a guess from its last rows, the
 * same guess Orca / Omnara-style dashboards make from these files. Two
 * timings keep it honest:
 *   - GRACE_MS: a tool call or a reply written a moment ago is most likely
 *     still streaming or an auto-approved tool running, so it reads
 *     "running" until the file has been quiet that long;
 *   - YOUR_TURN_MAX_MS: every finished session ends on a reply, so a reply
 *     older than this is "idle", or the waiting list would be every chat
 *     of the day. A pending approval stays waiting: it is really blocked.
 *
 * Pure and total: any line that is not the JSON we expect is skipped.
 */

export type HubState = "waiting" | "running" | "idle";

export interface HubClassified {
  state: HubState;
  reason: string;
  title: string | null;
  cwd: string | null;
  /** Codex's own session id (session_meta), for `codex resume`. */
  sessionId: string | null;
}

export interface ClassifyOptions {
  /** ms since the file was last written. */
  ageMs?: number;
  /** Lines from the start of the file, for the title and folder only. */
  headLines?: readonly string[];
}

export const GRACE_MS = 5_000;
export const RUNNING_MS = 30_000;
export const YOUR_TURN_MAX_MS = 2 * 60 * 60_000;
const TITLE_MAX = 80;

type Kind = "user" | "interrupt" | "tool-result" | "assistant-text" | "assistant-tool" | "assistant-other" | "error" | "turn-end";

interface Row {
  kind: Kind;
  toolIds: string[];
  resultIds: string[];
}

function parse(line: string): Record<string, unknown> | null {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function clip(text: string): string | null {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!line || line.startsWith("<")) return null;   // command and instruction wrappers, not what was typed
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** The decision both agents share, from their rows in file order. */
function decide(rows: readonly Row[], ageMs: number): { state: HubState; reason: string } {
  if (rows.length === 0) return { state: "idle", reason: "no messages yet" };
  // The newest tool call, and whether a result for it came after it.
  let pending = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const ids = rows[i]!.toolIds;
    if (ids.length === 0) continue;
    const last = ids[ids.length - 1]!;
    pending = !rows.slice(i + 1).some((r) => r.resultIds.includes(last))
      && !rows[i]!.resultIds.includes(last);
    break;
  }
  const lastKind = rows[rows.length - 1]!.kind;
  const fresh = ageMs < GRACE_MS;
  if (lastKind === "interrupt") return { state: "idle", reason: "interrupted" };
  if (lastKind === "error") return { state: "waiting", reason: "stopped on an error or a limit" };
  if (pending && lastKind !== "turn-end") {
    return fresh ? { state: "running", reason: "running a tool" } : { state: "waiting", reason: "approval pending" };
  }
  if (lastKind === "assistant-text" || lastKind === "turn-end") {
    if (fresh && lastKind !== "turn-end") return { state: "running", reason: "replying" };
    if (ageMs > YOUR_TURN_MAX_MS) return { state: "idle", reason: "finished" };
    return { state: "waiting", reason: "your turn" };
  }
  if (ageMs < RUNNING_MS) return { state: "running", reason: "working" };
  return { state: "idle", reason: "gone quiet" };
}

/* ---------------- Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl ---------------- */

function claudeRow(event: Record<string, unknown>): Row | null {
  const type = event["type"];
  if (type !== "user" && type !== "assistant") return null;
  if (event["isSidechain"] === true) return null;   // a subagent's rows, interleaved into the same file
  const message = obj(event["message"]);
  const content = message ? message["content"] : null;
  const blocks = Array.isArray(content) ? content.map(obj).filter((b): b is Record<string, unknown> => !!b) : [];
  const text = typeof content === "string" ? content
    : blocks.filter((b) => b["type"] === "text" && typeof b["text"] === "string").map((b) => b["text"] as string).join("\n");
  const toolIds = blocks.filter((b) => b["type"] === "tool_use" && typeof b["id"] === "string").map((b) => b["id"] as string);
  const resultIds = blocks.filter((b) => b["type"] === "tool_result" && typeof b["tool_use_id"] === "string")
    .map((b) => b["tool_use_id"] as string);
  if (type === "assistant") {
    if (event["isApiErrorMessage"] === true) return { kind: "error", toolIds: [], resultIds: [] };
    const kind: Kind = toolIds.length ? "assistant-tool" : text.trim() ? "assistant-text" : "assistant-other";
    return { kind, toolIds, resultIds: [] };
  }
  if (resultIds.length) return { kind: "tool-result", toolIds: [], resultIds };
  if (/^\[Request interrupted by user/.test(text.trim())) return { kind: "interrupt", toolIds: [], resultIds: [] };
  return { kind: "user", toolIds: [], resultIds: [] };
}

function claudeFirstUserText(event: Record<string, unknown>): string | null {
  if (event["type"] !== "user" || event["isSidechain"] === true || event["isMeta"] === true) return null;
  const content = obj(event["message"])?.["content"];
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) return null;
  for (const b of content.map(obj)) {
    if (b && b["type"] === "text" && typeof b["text"] === "string") {
      const t = clip(b["text"] as string);
      if (t) return t;
    }
  }
  return null;
}

export function classifyClaudeTail(lines: readonly string[], opts: ClassifyOptions = {}): HubClassified {
  const ageMs = typeof opts.ageMs === "number" ? opts.ageMs : Infinity;
  const head = Array.isArray(opts.headLines) ? opts.headLines : [];
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let cwd: string | null = null;
  let firstUser: string | null = null;
  for (const line of head) {
    const e = parse(line);
    if (!e) continue;
    if (e["type"] === "custom-title" && typeof e["customTitle"] === "string") customTitle = e["customTitle"] as string;
    if (e["type"] === "ai-title" && typeof e["aiTitle"] === "string") aiTitle = e["aiTitle"] as string;
    if (typeof e["cwd"] === "string" && e["isSidechain"] !== true) cwd = e["cwd"] as string;
    firstUser ??= claudeFirstUserText(e);
  }
  const rows: Row[] = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const e = parse(line);
    if (!e) continue;
    if (e["type"] === "custom-title" && typeof e["customTitle"] === "string") customTitle = e["customTitle"] as string;
    if (e["type"] === "ai-title" && typeof e["aiTitle"] === "string") aiTitle = e["aiTitle"] as string;
    const row = claudeRow(e);
    if (!row) continue;
    if (typeof e["cwd"] === "string") cwd = e["cwd"] as string;
    firstUser ??= claudeFirstUserText(e);
    rows.push(row);
  }
  const title = customTitle?.trim() || aiTitle?.trim() || firstUser;
  return { ...decide(rows, ageMs), title: title || null, cwd, sessionId: null };
}

/* ---------------- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ---------------- */

const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const CODEX_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

function codexText(p: Record<string, unknown>): string {
  const content = p["content"];
  if (!Array.isArray(content)) return "";
  return content.map(obj).filter((b): b is Record<string, unknown> => !!b && typeof b["text"] === "string")
    .map((b) => b["text"] as string).join("\n");
}

/** Codex puts its own `<environment_context>`-style blocks in as user messages. */
function codexIsWrapper(text: string): boolean {
  return /^<[a-z_]+>/i.test(text.trimStart());
}

function codexRow(event: Record<string, unknown>): Row | null {
  const p = obj(event["payload"]);
  if (!p) return null;
  if (event["type"] === "event_msg") {
    if (p["type"] === "task_complete") return { kind: "turn-end", toolIds: [], resultIds: [] };
    if (p["type"] === "turn_aborted") return { kind: "interrupt", toolIds: [], resultIds: [] };
    if (p["type"] === "error" || p["type"] === "stream_error") return { kind: "error", toolIds: [], resultIds: [] };
    return null;
  }
  if (event["type"] !== "response_item") return null;
  const t = p["type"];
  const callId = typeof p["call_id"] === "string" ? (p["call_id"] as string) : typeof p["id"] === "string" ? (p["id"] as string) : "";
  if (typeof t === "string" && CODEX_CALLS.has(t)) return { kind: "assistant-tool", toolIds: callId ? [callId] : [], resultIds: [] };
  if (typeof t === "string" && CODEX_OUTPUTS.has(t)) return { kind: "tool-result", toolIds: [], resultIds: callId ? [callId] : [] };
  if (t === "reasoning") return { kind: "assistant-other", toolIds: [], resultIds: [] };
  if (t !== "message") return null;
  const text = codexText(p);
  if (p["role"] === "assistant") return { kind: text.trim() ? "assistant-text" : "assistant-other", toolIds: [], resultIds: [] };
  if (p["role"] === "user" && text.trim() && !codexIsWrapper(text)) return { kind: "user", toolIds: [], resultIds: [] };
  return null;
}

function codexFirstUser(event: Record<string, unknown>): string | null {
  const p = obj(event["payload"]);
  if (!p || event["type"] !== "response_item" || p["type"] !== "message" || p["role"] !== "user") return null;
  const text = codexText(p);
  return codexIsWrapper(text) ? null : clip(text);
}

export function classifyCodexTail(lines: readonly string[], opts: ClassifyOptions = {}): HubClassified {
  const ageMs = typeof opts.ageMs === "number" ? opts.ageMs : Infinity;
  const head = Array.isArray(opts.headLines) ? opts.headLines : [];
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let firstUser: string | null = null;
  const meta = (e: Record<string, unknown>) => {
    const p = obj(e["payload"]);
    if (!p) return;
    if (e["type"] === "session_meta") {
      if (typeof p["id"] === "string") sessionId = p["id"] as string;
      if (typeof p["cwd"] === "string") cwd = p["cwd"] as string;
    }
    if (e["type"] === "turn_context" && typeof p["cwd"] === "string") cwd = p["cwd"] as string;
    firstUser ??= codexFirstUser(e);
  };
  for (const line of head) {
    const e = parse(line);
    if (e) meta(e);
  }
  const rows: Row[] = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const e = parse(line);
    if (!e) continue;
    meta(e);
    const row = codexRow(e);
    if (row) rows.push(row);
  }
  return { ...decide(rows, ageMs), title: firstUser, cwd, sessionId };
}
