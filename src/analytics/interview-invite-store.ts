import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  INTERVIEW_INVITE_FILE,
  mergeInterviewInviteStates,
  parseInterviewInviteState,
  type InterviewInviteState,
} from "./interview-invite.js";

/**
 * `<stateDir>/interview-invite.json`: when the interview invite was shown
 * and whether "don't ask again" was pressed (ATO-1467). The terminal and
 * the desktop share the state dir, so every write re-reads the file and
 * merges (a refusal on either side wins). Never throws.
 */
export function interviewInvitePath(stateDir: string): string {
  return join(stateDir, INTERVIEW_INVITE_FILE);
}

export function readInterviewInviteState(stateDir: string): InterviewInviteState {
  try {
    return parseInterviewInviteState(
      JSON.parse(readFileSync(interviewInvitePath(stateDir), "utf8")),
    );
  } catch {
    // Missing until the first show or refusal.
    return parseInterviewInviteState(null);
  }
}

/**
 * Apply `change` to the state as it is on disk now and write it back
 * (temp file + rename). Returns the written state, or null when it could
 * not be written: a show that cannot be recorded must not happen, since
 * an invite repeated on every launch is worse than none.
 */
export function updateInterviewInviteState(
  stateDir: string,
  change: (state: InterviewInviteState) => InterviewInviteState,
): InterviewInviteState | null {
  const current = readInterviewInviteState(stateDir);
  const next = mergeInterviewInviteStates(current, change(current));
  const path = interviewInvitePath(stateDir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return next;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing was written, or nothing can be removed.
    }
    return null;
  }
}
