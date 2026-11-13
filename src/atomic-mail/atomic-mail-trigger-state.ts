import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What the mail trigger (ATO-601) remembers between polls and restarts,
 * in `<stateDir>/atomic-mail-trigger.json` (0600):
 *
 *  - per binding, whether it has been primed and the ids it has seen.
 *    Priming happens on a binding's first poll: every message already
 *    in the inbox is marked seen and none becomes a task, so switching
 *    the trigger on never replays old mail.
 *  - the replies still owed (`replyByEmail`), so a restart between the
 *    task's end and the send does not lose one.
 *
 * A missing or corrupt file reads as empty — every binding primes
 * again, which errs on the side of not acting.
 */
export const MAIL_TRIGGER_STATE_FILENAME = "atomic-mail-trigger.json";

/** Seen ids kept per binding; the trigger reads far fewer than this per poll. */
export const SEEN_IDS_CAP = 500;

export interface PendingMailReply {
  taskId: string;
  binding: string;
  to: string;
  subject: string;
  createdAt: number;
}

export interface MailTriggerState {
  bindings: Record<string, { seen: string[] }>;
  pendingReplies: PendingMailReply[];
}

function empty(): MailTriggerState {
  return { bindings: {}, pendingReplies: [] };
}

function isReply(v: unknown): v is PendingMailReply {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.taskId === "string" &&
    typeof r.binding === "string" &&
    typeof r.to === "string" &&
    typeof r.subject === "string" &&
    typeof r.createdAt === "number"
  );
}

export function readMailTriggerState(path: string): MailTriggerState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty();
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty();
  const obj = raw as Record<string, unknown>;
  const state = empty();
  const bindings = obj.bindings;
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    for (const [name, value] of Object.entries(bindings as Record<string, unknown>)) {
      const seen = (value as { seen?: unknown } | null)?.seen;
      if (!Array.isArray(seen)) continue;
      state.bindings[name] = {
        seen: seen.filter((id): id is string => typeof id === "string").slice(-SEEN_IDS_CAP),
      };
    }
  }
  if (Array.isArray(obj.pendingReplies)) {
    state.pendingReplies = obj.pendingReplies.filter(isReply);
  }
  return state;
}

/** Write through a temp file so a crash mid-write leaves the old file. */
export function writeMailTriggerState(path: string, state: MailTriggerState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on filesystems without modes
  }
  renameSync(tmp, path);
}
