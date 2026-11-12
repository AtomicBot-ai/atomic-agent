/**
 * ATO-672. Parser for the note-reconcile sub-call. Accepts the GBNF line
 * shape and the Structured Outputs JSON shape. Ids outside `allowlist`
 * are dropped, repeats collapse, and the result is capped.
 *
 * A DUPLICATE wins over SUPERSEDE lines in the same answer: "the new
 * note adds nothing" and "the new note replaces this one" cannot both be
 * true, and dropping the new note is the smaller change.
 */
export type NoteReconcileAction = "SUPERSEDE" | "DUPLICATE";

export interface NoteReconcileDecision {
  action: NoteReconcileAction;
  id: number;
}

export type ParsedNoteReconcileOutput =
  | { kind: "none" }
  | { kind: "supersede"; ids: number[] }
  | { kind: "duplicate"; id: number };

const LINE_RE = /^(SUPERSEDE|DUPLICATE)\s+(\d+)\s*$/;

export function parseNoteReconcileOutput(
  raw: string,
  opts: { allowlist: ReadonlySet<number>; maxSupersede?: number },
): ParsedNoteReconcileOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /^NONE\s*$/i.test(trimmed)) return { kind: "none" };
  const decisions =
    trimmed.startsWith("{") ? (fromJson(trimmed) ?? fromLines(trimmed)) : fromLines(trimmed);
  return decide(decisions, opts.allowlist, opts.maxSupersede ?? 2);
}

function fromLines(text: string): NoteReconcileDecision[] {
  const out: NoteReconcileDecision[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = LINE_RE.exec(rawLine.trim());
    if (!match) continue;
    out.push({ action: match[1] as NoteReconcileAction, id: Number(match[2]) });
  }
  return out;
}

function fromJson(text: string): NoteReconcileDecision[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["kind"] === "none") return [];
  if (obj["kind"] !== "decisions" || !Array.isArray(obj["decisions"])) return null;
  const out: NoteReconcileDecision[] = [];
  for (const entry of obj["decisions"] as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { action, id } = entry as { action?: unknown; id?: unknown };
    if ((action === "SUPERSEDE" || action === "DUPLICATE") && typeof id === "number") {
      out.push({ action, id });
    }
  }
  return out;
}

function decide(
  decisions: readonly NoteReconcileDecision[],
  allowlist: ReadonlySet<number>,
  maxSupersede: number,
): ParsedNoteReconcileOutput {
  const valid = decisions.filter(
    (d) => Number.isInteger(d.id) && d.id > 0 && allowlist.has(d.id),
  );
  const duplicate = valid.find((d) => d.action === "DUPLICATE");
  if (duplicate) return { kind: "duplicate", id: duplicate.id };
  const ids: number[] = [];
  for (const d of valid) {
    if (ids.includes(d.id)) continue;
    ids.push(d.id);
    if (ids.length >= maxSupersede) break;
  }
  return ids.length === 0 ? { kind: "none" } : { kind: "supersede", ids };
}
