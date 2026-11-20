import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What the IMAP mail trigger (ATO-601) remembers, in
 * `<stateDir>/imap-mail-trigger.json` (0600): per binding, which
 * mailbox it watched (`account`), the folder's UIDVALIDITY, and the
 * highest UID already handled. A new account, a new UIDVALIDITY, or a
 * missing or corrupt file primes the binding again: the mail already
 * there is skipped and none becomes a task, so old mail is never
 * replayed.
 */
export const IMAP_TRIGGER_STATE_FILENAME = "imap-mail-trigger.json";

export interface ImapBindingState {
  account: string;
  uidValidity: number;
  lastUid: number;
}

export interface ImapTriggerState {
  bindings: Record<string, ImapBindingState>;
}

function isEntry(v: unknown): v is ImapBindingState {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.account === "string" &&
    Number.isSafeInteger(e.uidValidity) &&
    Number.isSafeInteger(e.lastUid) &&
    (e.lastUid as number) >= 0
  );
}

export function readImapTriggerState(path: string): ImapTriggerState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { bindings?: unknown };
    const out: ImapTriggerState = { bindings: {} };
    if (raw.bindings && typeof raw.bindings === "object") {
      for (const [name, entry] of Object.entries(raw.bindings as Record<string, unknown>)) {
        if (isEntry(entry)) out.bindings[name] = { account: entry.account, uidValidity: entry.uidValidity, lastUid: entry.lastUid };
      }
    }
    return out;
  } catch {
    return { bindings: {} };
  }
}

/** Atomic (temp file + rename), owner-only. */
export function writeImapTriggerState(path: string, state: ImapTriggerState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
