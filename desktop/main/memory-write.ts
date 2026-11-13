/**
 * ATO-582: the Memory tab's edits (change or delete a note, change or
 * delete a profile fact) go through the running agent, never through SQL of
 * the desktop's own. memory.sqlite is shared with the terminal
 * (~/.atomic-agent) and the agent keeps the notes' FTS index and their
 * vectors next to the rows: only the agent's own store can change one and
 * keep the others in step. memory-db.ts stays read-only.
 *
 * The routes are the agent's (ATO-1124, PR #1306, src/http/route-memory.ts):
 *   PATCH  /api/memory/notes/{id}  {text}  → { note }
 *   DELETE /api/memory/notes/{id}          → { removed: true, id }
 *   PATCH  /api/memory/profile/{key} {value} → { fact }
 *   DELETE /api/memory/profile/{key}       → { removed: true, key }
 * An agent from before them answers 404 "No route for …": that is
 * `unsupported`, and the tab asks to update the agent. A 404 of the route's
 * own ("note not found") is `gone`: someone (the agent, the terminal)
 * removed it first, and the tab just reads the list again.
 */

/** Every path in one place, so a change of the agent's routes is one edit. */
export const MEMORY_WRITE_PATHS = {
  note: (id: number) => `/api/memory/notes/${id}`,
  profileFact: (key: string) => `/api/memory/profile/${encodeURIComponent(key)}`,
} as const;

/** The agent's own limit is checked there; this only keeps a runaway paste off the wire. */
export const MEMORY_NOTE_MAX_CHARS = 64_000;

export type MemoryWriteOp =
  | { op: "note.edit"; id: number; text: string }
  | { op: "note.delete"; id: number }
  | { op: "profile.edit"; key: string; value: string }
  | { op: "profile.delete"; key: string };

export type MemoryWriteResult =
  | { ok: true; op: MemoryWriteOp["op"]; body: unknown }
  | { ok: false; reason: "invalid" | "unsupported" | "gone" | "error"; error: string; status?: number };

/** What the renderer sent, checked: a typed op, or why it was refused. */
export function parseMemoryWriteOp(raw: unknown): MemoryWriteOp | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "a memory edit must be an object";
  const r = raw as Record<string, unknown>;
  const idOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (r.op === "note.delete") return idOk(r.id) ? { op: "note.delete", id: r.id } : "note id must be a positive integer";
  if (r.op === "note.edit") {
    if (!idOk(r.id)) return "note id must be a positive integer";
    if (typeof r.text !== "string") return "text must be a string";
    if (!r.text.trim()) return "A note cannot be empty";
    if (r.text.length > MEMORY_NOTE_MAX_CHARS) return `A note is at most ${MEMORY_NOTE_MAX_CHARS} characters`;
    return { op: "note.edit", id: r.id, text: r.text };
  }
  if (r.op === "profile.delete" || r.op === "profile.edit") {
    if (typeof r.key !== "string" || !r.key.trim() || r.key.length > 400 || r.key.includes("\0")) return "profile key is required";
    if (r.op === "profile.delete") return { op: "profile.delete", key: r.key };
    if (typeof r.value !== "string") return "value must be a string";
    if (!r.value.trim()) return "A fact cannot be empty";
    if (r.value.length > MEMORY_NOTE_MAX_CHARS) return `A fact is at most ${MEMORY_NOTE_MAX_CHARS} characters`;
    return { op: "profile.edit", key: r.key, value: r.value };
  }
  return "unknown memory edit";
}

/** The request one op makes. */
export function memoryWriteRequest(op: MemoryWriteOp): { method: "PATCH" | "DELETE"; path: string; body?: unknown } {
  if (op.op === "note.edit") return { method: "PATCH", path: MEMORY_WRITE_PATHS.note(op.id), body: { text: op.text } };
  if (op.op === "note.delete") return { method: "DELETE", path: MEMORY_WRITE_PATHS.note(op.id) };
  if (op.op === "profile.edit") return { method: "PATCH", path: MEMORY_WRITE_PATHS.profileFact(op.key), body: { value: op.value } };
  return { method: "DELETE", path: MEMORY_WRITE_PATHS.profileFact(op.key) };
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    return typeof parsed?.error?.message === "string" ? parsed.error.message : "";
  } catch {
    return "";
  }
}

/** The agent's answer, read: what the tab should do with it. */
export function interpretMemoryWrite(op: MemoryWriteOp, status: number, text: string): MemoryWriteResult {
  if (status >= 200 && status < 300) {
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: true, op: op.op, body };
  }
  const message = errorMessage(text);
  // The router's own 404 (http-server.ts): this agent has no such route.
  if (status === 404 && (/^No route for /.test(message) || !message)) {
    return { ok: false, reason: "unsupported", error: "Update the agent to edit memory here", status };
  }
  if (status === 404) return { ok: false, reason: "gone", error: message, status };
  if (status === 405 || status === 501) return { ok: false, reason: "unsupported", error: "Update the agent to edit memory here", status };
  return { ok: false, reason: "error", error: message || `HTTP ${status}`, status };
}

export interface MemoryWriteTarget { base: string; headers: Record<string, string> }

/**
 * Send one op to the agent. `target` is read at call time (the agent may be
 * stopped, or remote); it throws "agent is not running" when there is none.
 * Never throws: every failure is a result.
 */
export async function runMemoryWrite(
  raw: unknown,
  target: () => MemoryWriteTarget,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<MemoryWriteResult> {
  const op = parseMemoryWriteOp(raw);
  if (typeof op === "string") return { ok: false, reason: "invalid", error: op };
  const req = memoryWriteRequest(op);
  try {
    const { base, headers } = target();
    const res = await fetchImpl(`${base}${req.path}`, {
      method: req.method,
      headers,
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return interpretMemoryWrite(op, res.status, await res.text());
  } catch (err) {
    return { ok: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
