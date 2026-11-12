import type { ApprovalCategory } from "./approval-level.js";

/**
 * Review after outside content (ATO-618, `agent.taintReview`, off by
 * default). Once a turn has read text someone else wrote (a web page, an
 * MCP answer, an HTTP body, the mail inbox: every tool with
 * `untrustedOutput` or `externalSource`, see `tools/tool-registry.ts`),
 * that text may be steering the agent. An action that the level or a
 * session grant would run silently, and that could send data out or act
 * outward, is then not run silently: it goes to the smart-approval
 * reviewer with the question "does this action serve what the user asked
 * for?" (the AlignmentCheck idea), and to the person when the reviewer is
 * off, fails, or says anything but `low`.
 *
 * The taint is per session and lasts until the next turn starts. A steer
 * does not clear it: the outside text is still in the context.
 */

/**
 * Whether an auto-approved request of `category` is held back after
 * outside content. A `Record` so a new category needs an explicit answer.
 * `true`: the action can carry data off the machine, act under the
 * operator's accounts, or run code. `false`: it stays inside the
 * workspace, only reads or looks, or is recoverable locally.
 */
const TAINT_SENSITIVE: Record<ApprovalCategory, boolean> = {
  fs_write_workspace: false,
  fs_write_home: true,
  fs_trash: false,
  http: true,
  shell: true,
  shell_dangerous: true,
  script: true,
  proc_kill: false,
  git_remote: true,
  browser_nonweb: true,
  browser_commit: true,
  browser_secret: true,
  browser_offsite: true,
  trust_config: true,
  publish: true,
  email: true,
  fusion_fanout: false,
  fs_read_outside: false,
  state_secret: true,
  paid_generation: false,
  screen_control: true,
  screen_capture: false,
  local_model_restart: false,
  hook_ask: false,
  // MCP tools that are gated land here: arbitrary third-party code.
  other: true,
};

export function isTaintSensitive(category: ApprovalCategory): boolean {
  return TAINT_SENSITIVE[category];
}

/** Sessions remembered at once; the oldest is dropped beyond this. */
const TAINT_SESSION_CAP = 256;
/** Distinct sources kept per session; enough to name them on a prompt. */
const TAINT_SOURCES_CAP = 8;
/** Longest source label kept (labels come from code and MCP config). */
const TAINT_SOURCE_MAX_CHARS = 80;

/** Which sessions read outside content in their running turn, and from where. */
export class UntrustedTaint {
  private readonly bySession = new Map<string, string[]>();

  mark(sessionId: string, source: string): void {
    const label = cleanSource(source);
    const sources = this.bySession.get(sessionId) ?? [];
    if (!sources.includes(label) && sources.length < TAINT_SOURCES_CAP) sources.push(label);
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, sources);
    if (this.bySession.size > TAINT_SESSION_CAP) {
      const oldest = this.bySession.keys().next().value;
      if (oldest !== undefined) this.bySession.delete(oldest);
    }
  }

  /** The sources read this turn; empty when the session is clean. */
  sources(sessionId: string): readonly string[] {
    return this.bySession.get(sessionId) ?? [];
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

function cleanSource(source: string): string {
  const flat = source.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const label = flat.length > 0 ? flat : "an outside source";
  return label.length > TAINT_SOURCE_MAX_CHARS
    ? `${label.slice(0, TAINT_SOURCE_MAX_CHARS - 1)}…`
    : label;
}

/** Decision reason of a held request the reviewer let through. */
export const TAINT_REVIEW_LOW_REASON = "auto-approved (risk review after outside content: low)";

/** The note a held request carries to the person. */
export function formatTaintNote(sources: readonly string[], riskNote: string | null): string {
  const read = `read outside content this turn (${sources.join(", ")})`;
  return riskNote === null ? `${read}, asking you` : `${read}; ${riskNote}`;
}
