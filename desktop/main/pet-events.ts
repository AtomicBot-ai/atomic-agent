/**
 * ATO-2391: the desktop pet, the part that reads the agent's frames.
 *
 * Pure (no Electron import, so the node tests load it as is). It watches the
 * same two streams the main window draws from: the turn frames AgentClient
 * emits as `chat` (main.ts sends them on agent:chat) and the approval
 * requests it emits as `approval` (GET /api/events). From them it keeps:
 *
 * - the turns running now and what each is doing: thinking (reasoning,
 *   writing the reply) or working (a tool call);
 * - the approval requests still waiting, as the bubble shows them;
 * - how a turn ended (done, error, stopped), which observeChat returns.
 *
 * The error bookkeeping is TurnNotifier's (turn-notify.ts): a named error
 * frame is followed by `done` in the same stream, and the turn failed only
 * when no work came after it.
 *
 * What the pet may offer for a request is decided here too (petCanAllow):
 * Allow once and Deny for an ordinary request; only Open (and Deny) for a
 * question, a high risk verdict, a request held after outside content (a
 * riskNote), one with no preview of the action, or a category that deserves
 * the full card. The pet never answers anything by itself.
 *
 * The bubble's words are the action itself (the preview's first line, e.g.
 * the shell command), with the gate's reason under it: the reason alone is
 * often generic ("no shell guard rule matched; approval required in ...").
 */

export type PetActivity = "thinking" | "working";
export type PetEnding = "done" | "error" | "stopped";

/** One waiting request, as the bubble shows it. Plain text: the page sets textContent. */
export interface PetApproval {
  approvalId: string;
  sessionId: string | null;
  tool: string;
  /** What is asked: the preview's first line (the command), clipped; the reason when there is no preview. */
  text: string;
  /** The gate's reason, a second line under `text`, or "". */
  detail: string;
  /** "Risk check: medium. Installs a package", the held-after-outside-content note, or "". */
  risk: string;
  /** An ask_user question: answered in the window, never with Allow. */
  question: boolean;
  /** False: the bubble offers Open and Deny, and Allow only in the window's own card. */
  canAllow: boolean;
  seenAt: number;
}

/** Requests the bubble never allows: the full card, with its details, decides them. */
export const PET_WINDOW_ONLY_CATEGORIES: readonly string[] = [
  "shell_dangerous",
  "trust_config",
  "browser_secret",
  "state_secret",
];

/** A turn with no frame for this long is taken as gone (its end frame was lost). */
export const PET_TURN_STALE_MS = 15 * 60_000;
/** Answered ids kept, so a replay of the same request does not reopen the bubble. */
const CLOSED_MAX = 200;
const TEXT_MAX = 140;

const RISK_LEVELS = ["low", "medium", "high"];

/** One line, no control characters, at most `max` characters. */
export function petClean(raw: unknown, max = TEXT_MAX): string {
  if (typeof raw !== "string") return "";
  const flat = Array.from(raw)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || code === 0x7f || (code >= 0x80 && code < 0xa0) ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/** The preview's first line, cleaned; "" when there is none. */
function previewFirstLine(p: Record<string, unknown>): string {
  return typeof p.preview === "string" ? petClean(p.preview.replace(/\r\n?/g, "\n").split("\n")[0]) : "";
}

/**
 * The bubble shows the whole command: one non-blank line, not clipped. A
 * shell preview keeps its newlines (`ls\nnpm i evil-pkg`) and a long line is
 * cut at TEXT_MAX, so either would hide what runs behind the first words.
 */
function previewFitsBubble(p: Record<string, unknown>): boolean {
  if (typeof p.preview !== "string") return false;
  const lines = p.preview.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) return false;
  return petClean(lines[0], Number.MAX_SAFE_INTEGER) === petClean(lines[0]);
}

/** The gate held it after outside content (approval-gate.ts formatTaintNote). */
function hasRiskNote(p: Record<string, unknown>): boolean {
  return typeof p.riskNote === "string" && p.riskNote.trim() !== "";
}

/**
 * The risk line, in the card's words (renderer/approval-risk.js apprRiskLine),
 * followed by the note of a request held after outside content.
 */
export function petRiskLine(p: Record<string, unknown>): string {
  const level = typeof p.riskLevel === "string" && RISK_LEVELS.includes(p.riskLevel) ? p.riskLevel : "";
  const reason = level ? petClean(p.riskReason, 100) : "";
  const verdict = !level ? "" : reason ? `Risk check: ${level}. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}` : `Risk check: ${level}.`;
  const note = hasRiskNote(p) ? petClean(p.riskNote, 160) : "";
  return [verdict, note].filter(Boolean).join(" ");
}

/** Whether the bubble may offer Allow once for this request. */
export function petCanAllow(p: Record<string, unknown>): boolean {
  if (p.category === "user_question") return false;
  if (p.riskLevel === "high") return false;
  // Held after outside content: the full card shows what came in and why.
  if (hasRiskNote(p)) return false;
  // Nothing shows what would run: never allow it unseen.
  if (!previewFirstLine(p)) return false;
  // More than one line, or clipped: the person opens the full card.
  if (!previewFitsBubble(p)) return false;
  return !(typeof p.category === "string" && PET_WINDOW_ONLY_CATEGORIES.includes(p.category));
}

/** An approval frame → the bubble's request; null when it is not one. */
export function petApprovalFrom(raw: unknown, now: number): PetApproval | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.approvalId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(p.approvalId)) return null;
  const question = p.category === "user_question";
  const action = previewFirstLine(p);
  const reason = petClean(p.reason);
  const text = question ? "The agent has a question for you." : action || reason;
  const detail = question || !action || reason === action ? "" : reason;
  return {
    approvalId: p.approvalId,
    sessionId: typeof p.sessionId === "string" && p.sessionId ? p.sessionId : null,
    tool: petClean(p.tool, 60) || "a tool",
    text,
    detail,
    risk: petRiskLine(p),
    question,
    canAllow: petCanAllow(p),
    seenAt: now,
  };
}

/** The two answers the bubble gives; the window's card keeps every other one. */
export type PetDecision = "allow-once" | "deny";

/**
 * The bubble's click → the decision sent on, or why none is. Only a request
 * the pet is showing, and Allow only where the bubble offers it: a question
 * or a request kept for the full card is never allowed from here.
 */
export function petDecision(raw: unknown, shown: PetApproval | null): { decision: PetDecision } | { error: string } {
  const r = raw && typeof raw === "object" ? (raw as { approvalId?: unknown; decision?: unknown }) : {};
  if (!shown || r.approvalId !== shown.approvalId) return { error: "This request is no longer waiting." };
  if (r.decision === "deny" && !shown.question) return { decision: "deny" };
  if (r.decision === "allow" && shown.canAllow) return { decision: "allow-once" };
  return { error: "Open Atomic Agent to answer this one." };
}

interface TurnRec {
  sessionId: string | null;
  activity: PetActivity;
  heldError: boolean;
  workAfterError: boolean;
  lastAt: number;
}

const THINKING_KINDS = new Set(["delta", "reasoning_progress", "progress_note", "steer_applied", "compaction_started", "compaction_progress"]);
const WORKING_KINDS = new Set(["tool_progress", "tool_update"]);

export class PetTracker {
  private readonly turns = new Map<string, TurnRec>();
  private readonly approvals = new Map<string, PetApproval>();
  private readonly closed = new Set<string>();

  /** One `chat` event. Returns how the turn ended, when this frame ended it. */
  observeChat(raw: unknown, now: number): PetEnding | null {
    if (!raw || typeof raw !== "object") return null;
    const ev = raw as { turnId?: unknown; kind?: unknown; payload?: unknown };
    if (typeof ev.turnId !== "string" || typeof ev.kind !== "string") return null;
    const kind = ev.kind;
    let t = this.turns.get(ev.turnId);
    if (!t) {
      t = { sessionId: null, activity: "thinking", heldError: false, workAfterError: false, lastAt: now };
      this.turns.set(ev.turnId, t);
    }
    t.lastAt = now;
    const p = ev.payload && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : null;
    if (kind === "session_id" && p) {
      const sid = typeof p.sessionId === "string" ? p.sessionId : typeof p.session_id === "string" ? p.session_id : null;
      if (sid) t.sessionId = sid;
      return null;
    }
    if (kind === "error" && p) {
      t.heldError = true;
      t.workAfterError = false;
      return null;
    }
    if (WORKING_KINDS.has(kind) || THINKING_KINDS.has(kind)) {
      t.activity = WORKING_KINDS.has(kind) ? "working" : "thinking";
      if (t.heldError) t.workAfterError = true;
      return null;
    }
    let ending: PetEnding | null = null;
    if (kind === "aborted") ending = "stopped";
    else if (kind === "error") ending = "error";
    else if (kind === "done") ending = t.heldError && !t.workAfterError ? "error" : "done";
    if (!ending) return null;
    this.turns.delete(ev.turnId);
    // A request of a turn that is over waits for nothing any more.
    if (t.sessionId) for (const a of [...this.approvals.values()]) if (a.sessionId === t.sessionId) this.drop(a.approvalId);
    return ending;
  }

  /** One `approval` event. True when it is a new request for the bubble. */
  observeApproval(raw: unknown, now: number): boolean {
    const a = petApprovalFrom(raw, now);
    if (!a || this.closed.has(a.approvalId) || this.approvals.has(a.approvalId)) return false;
    this.approvals.set(a.approvalId, a);
    return true;
  }

  /** The request was answered (here, in the window, or found no longer waiting). */
  approvalAnswered(approvalId: string): boolean {
    if (!this.approvals.has(approvalId)) {
      this.markClosed(approvalId);
      return false;
    }
    this.drop(approvalId);
    return true;
  }

  approval(approvalId: string): PetApproval | null {
    return this.approvals.get(approvalId) ?? null;
  }

  /** Waiting requests, oldest first. */
  pending(): PetApproval[] {
    return [...this.approvals.values()].sort((a, b) => a.seenAt - b.seenAt);
  }

  /** What the running turns do: working beats thinking; null when none runs. */
  activity(now: number): PetActivity | null {
    let out: PetActivity | null = null;
    for (const [id, t] of [...this.turns]) {
      if (now - t.lastAt > PET_TURN_STALE_MS) {
        this.turns.delete(id);
        continue;
      }
      if (t.activity === "working") return "working";
      out = "thinking";
    }
    return out;
  }

  private drop(approvalId: string): void {
    this.approvals.delete(approvalId);
    this.markClosed(approvalId);
  }

  private markClosed(approvalId: string): void {
    this.closed.add(approvalId);
    while (this.closed.size > CLOSED_MAX) this.closed.delete(this.closed.values().next().value as string);
  }
}
