/**
 * ATO-2755: a notification when the agent waits for your OK, not only when
 * a turn ends (turn-notify.ts is the other half).
 *
 * Pure (no Electron import, so the node tests load it as is); the wiring is
 * approval-notify-ipc.ts. A request reaches it two ways:
 *
 * - from the main window's page (renderer/approval-notify.js), once its card
 *   is drawn or kept for its chat: the page knows the chat's title, whether
 *   that chat is the one on screen, and the card's own question ("Allow
 *   Atomic Agent to run `npm test`?"), so the words match the card;
 * - straight from the agent's events stream, used only while there is no
 *   main window to draw the card (closed to the tray or the Dock): then the
 *   words come from approvalActionText, the card's main rules in plain text.
 *
 * One notification per request id, however many times the stream replays
 * it, and none for a request that arrived while the window was focused on
 * its chat. Same switch as the turn-end note: `tui.notify.enabled`. A
 * request answered from the window or the pet closes its notification; one
 * whose card went away (answered elsewhere, its turn over) closes once the
 * page's list of open cards stops naming it (stillOpen).
 */

import { cleanNotificationText } from "./turn-notify.js";

export const APPROVAL_NOTE_TITLE = "Atomic Agent needs your OK";
export const QUESTION_NOTE_TITLE = "Atomic Agent has a question";

export interface ApprovalNote {
  title: string;
  body: string;
}

/** What the page says about a card it holds (approvalNotify:describe). */
export interface ApprovalDescription {
  approvalId: string;
  sessionId: string | null;
  /** The chat's title as the sidebar shows it, or "". */
  chat: string;
  /** The card's question in plain text. */
  action: string;
  question: boolean;
  /** The card is drawn in the chat on screen. */
  onScreen: boolean;
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const SEEN_MAX = 500;

function clip(text: string, max: number): string {
  const flat = cleanNotificationText(text);
  return Array.from(flat).length > max ? Array.from(flat).slice(0, max - 1).join("").trimEnd() + "…" : flat;
}

/** The page's message → a description, or null when it is not one. */
export function readApprovalDescription(raw: unknown): ApprovalDescription | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.approvalId !== "string" || !ID_RE.test(r.approvalId)) return null;
  const sessionId = typeof r.sessionId === "string" && ID_RE.test(r.sessionId) ? r.sessionId : null;
  return {
    approvalId: r.approvalId,
    sessionId,
    chat: typeof r.chat === "string" ? r.chat : "",
    action: typeof r.action === "string" ? r.action : "",
    question: r.question === true,
    onScreen: r.onScreen === true,
  };
}

/** Title and body: the chat on the first line of the body, what it asks on the second. */
export function formatApprovalNote(p: { chat: string; action: string; question: boolean }): ApprovalNote {
  const chat = clip(p.chat, 80);
  const action = clip(p.action, 160) || (p.question ? "The agent has a question for you." : "The agent is waiting for your answer.");
  return { title: p.question ? QUESTION_NOTE_TITLE : APPROVAL_NOTE_TITLE, body: chat ? `${chat}\n${action}` : action };
}

/** renderer.js APPR_FALLBACK, for the categories a request most often has. */
const FALLBACK: Record<string, string> = {
  fs_write_workspace: "change a file in this folder",
  fs_write_home: "change a file outside this folder",
  fs_trash: "move files to the Trash",
  http: "send a web request",
  http_write: "send data in a web request",
  shell: "run a command",
  shell_dangerous: "run a dangerous command",
  script: "run a skill script",
  proc_kill: "stop a process",
  trust_config: "change its own settings",
  publish: "publish to GitHub",
  git_remote: "talk to a git remote",
  email: "send an e-mail",
  fs_read_outside: "read outside this folder",
  paid_generation: "make a paid image in the cloud",
  browser_commit: "submit, publish or delete something on a website",
  browser_secret: "enter a password or payment details on a website",
  browser_offsite: "open a site outside the allowed list",
  state_secret: "touch its own secret files",
  screen_control: "click and type on your screen",
  screen_capture: "take a screenshot of your screen",
};

function quoted(s: string): string {
  return `"${clip(s, 90)}"`;
}

/**
 * The card's question (renderer.js apprAsk) in plain text, for a request
 * no page described: the command for a shell call, the request's host, the
 * agent's own clause when it reads as one, else the category's words.
 */
export function approvalActionText(raw: unknown): { action: string; question: boolean } {
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (p.category === "user_question") {
    const q = p.question && typeof p.question === "object" ? (p.question as { prompt?: unknown }).prompt : null;
    return { action: typeof q === "string" && q.trim() ? q.trim() : "The agent has a question for you.", question: true };
  }
  const ask = (h: string) => ({ action: `Allow Atomic Agent to ${h}?`, question: false });
  const reason = typeof p.reason === "string" ? p.reason.trim() : "";
  const preview = typeof p.preview === "string" ? p.preview.trim() : "";
  const firstLine = (s: string) => s.split(/\r?\n/)[0]!.trim();
  if ((p.category === "shell" || p.tool === "os.shell.run") && preview && preview !== "(no preview)") {
    return ask(`run ${quoted(firstLine(preview))}`);
  }
  let mt: RegExpExecArray | null;
  if (p.category === "http" && (mt = /^([A-Z]+) (\S+)/.exec(reason))) {
    let host = mt[2]!;
    try { host = new URL(host).host; } catch { /* keep it */ }
    return ask(`send a ${mt[1]} request to ${host}`);
  }
  if (p.category === "email" && (mt = /^e-mail to ([^:]+)/.exec(reason))) return ask(`send an e-mail to ${mt[1]!.trim()}`);
  const clause = firstLine(reason).split(/ \u2014 |; /)[0]!.trim();
  if (/^[a-z]/.test(clause) && clause.length <= 140 && !/approval required|guard|fail-closed/.test(clause)) return ask(clause);
  return ask(typeof p.category === "string" && FALLBACK[p.category] ? FALLBACK[p.category]! : "go ahead");
}

/** GET /api/sessions/{id} → the chat's title (metadata.title), or "". */
export function sessionTitleOf(raw: unknown): string {
  const meta = raw && typeof raw === "object" ? (raw as { metadata?: unknown }).metadata : null;
  const t = meta && typeof meta === "object" ? (meta as { title?: unknown }).title : null;
  return typeof t === "string" ? t.trim() : "";
}

export interface ApprovalTarget {
  approvalId: string;
  sessionId: string | null;
}

export interface ApprovalNotifierDeps {
  /** True while the user is looking at the main window. */
  isFocused: () => boolean;
  /** `tui.notify.enabled` as the config file has it now. */
  readEnabled: () => Promise<boolean>;
  /** A main window exists, so its page draws the card and describes it. */
  pageAlive: () => boolean;
  /** The chat's title, for a request no page described. */
  chatTitle: (sessionId: string) => Promise<string>;
  /** Raises the notification; returns how to close it, when it can be closed. */
  show: (note: ApprovalNote, target: ApprovalTarget) => (() => void) | void;
}

/** A Set that forgets its oldest entries past `max`. */
function remember(set: Set<string>, id: string): void {
  set.delete(id);
  set.add(id);
  while (set.size > SEEN_MAX) set.delete(set.values().next().value as string);
}

export class ApprovalNotifier {
  /** Requests decided once (notified, or skipped for good). */
  private readonly seen = new Set<string>();
  /** Requests answered here, so a late notification is not raised. */
  private readonly answeredIds = new Set<string>();
  private readonly shown = new Map<string, () => void>();
  /** Requests the page described: only those can be found gone from its list. */
  private readonly described = new Set<string>();
  /** How many page lists in a row a shown request was missing from. */
  private readonly missing = new Map<string, number>();

  constructor(private readonly deps: ApprovalNotifierDeps) {}

  /** The page drew (or kept) a card. True when a notification went up. */
  async fromPage(raw: unknown): Promise<boolean> {
    const d = readApprovalDescription(raw);
    if (d) remember(this.described, d.approvalId);
    if (!d || this.seen.has(d.approvalId) || this.answeredIds.has(d.approvalId)) return false;
    remember(this.seen, d.approvalId);
    // Someone looking at that very chat sees the card come up.
    if (d.onScreen && this.deps.isFocused()) return false;
    return this.raise(formatApprovalNote(d), d, () => d.onScreen && this.deps.isFocused());
  }

  /** A frame of the agent's events stream. Only used while no page draws it. */
  async fromAgent(raw: unknown): Promise<boolean> {
    if (this.deps.pageAlive()) return false;
    const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const approvalId = typeof p.approvalId === "string" && ID_RE.test(p.approvalId) ? p.approvalId : null;
    if (!approvalId || this.seen.has(approvalId) || this.answeredIds.has(approvalId)) return false;
    remember(this.seen, approvalId);
    const sessionId = typeof p.sessionId === "string" && ID_RE.test(p.sessionId) ? p.sessionId : null;
    let chat = "";
    if (sessionId) {
      try { chat = await this.deps.chatTitle(sessionId); } catch { /* the action alone */ }
    }
    return this.raise(formatApprovalNote({ chat, ...approvalActionText(p) }), { approvalId, sessionId }, () => false);
  }

  /** The request was answered (the window's card, the pet): its notification goes. */
  answered(approvalId: string): void {
    if (typeof approvalId !== "string" || !approvalId) return;
    remember(this.answeredIds, approvalId);
    const close = this.shown.get(approvalId);
    this.shown.delete(approvalId);
    try { close?.(); } catch { /* already gone */ }
  }

  /** The notification was clicked or dismissed: nothing left to close. */
  forget(approvalId: string): void {
    this.shown.delete(approvalId);
    this.missing.delete(approvalId);
  }

  /**
   * The page's list of the cards still open (approvalNotify:pending, sent
   * on every change and every few seconds). The events stream has no
   * "resolved" frame, so a request answered in the TUI, Telegram or the
   * phone, or dropped with its turn (stopped, timed out), is known only by
   * its card going away. A shown request the page described and now lists
   * no more, in two lists in a row (a page that just loaded lists nothing
   * until the replay), is taken as over: its notification closes. Returns
   * the ids closed.
   */
  stillOpen(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const open = new Set(raw.filter((x): x is string => typeof x === "string"));
    const closed: string[] = [];
    for (const id of [...this.shown.keys()]) {
      if (!this.described.has(id)) continue;
      if (open.has(id)) { this.missing.delete(id); continue; }
      const n = (this.missing.get(id) ?? 0) + 1;
      if (n < 2) { this.missing.set(id, n); continue; }
      this.missing.delete(id);
      this.answered(id);
      closed.push(id);
    }
    return closed;
  }

  private async raise(note: ApprovalNote, target: ApprovalTarget, nowSeen: () => boolean): Promise<boolean> {
    try {
      if (!(await this.deps.readEnabled())) return false;
      // Answered, or looked at, while the config was being read.
      if (this.answeredIds.has(target.approvalId) || nowSeen()) return false;
      const close = this.deps.show(note, target);
      if (typeof close === "function") this.shown.set(target.approvalId, close);
      return true;
    } catch {
      // A notifier must never be the thing that fails.
      return false;
    }
  }
}
