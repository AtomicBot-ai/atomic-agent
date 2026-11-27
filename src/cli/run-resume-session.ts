import type { SessionState } from "../session/session-state.js";
import type { SessionStore } from "../session/session-store.js";
import { resolveShareSession } from "./share-command.js";

/** What `run --resume` / `--continue` reads from the store. */
export type ResumeSessionStore = Pick<SessionStore, "load" | "listSummaryPage">;

/**
 * The saved chat `run --resume <id>` or `run --continue` goes on with
 * (ATO-2307). `latest` (`--continue`, like `claude --continue`) is the
 * newest chat that ran in `cwd`, never a chat from another folder; an
 * id may be a unique prefix, as in `share --session`. The chat keeps
 * its own working folder.
 */
export function loadResumeSession(
  store: ResumeSessionStore,
  wanted: string,
  cwd: string,
): SessionState | { error: string } {
  let id: string;
  if (wanted === "latest") {
    const here = store
      .listSummaryPage({ limit: 200 })
      .find((row) => row.workingDir === cwd);
    if (!here) return { error: `there is no saved chat in ${cwd} to continue` };
    id = here.id;
  } else {
    const found = resolveShareSession(store, wanted, cwd);
    if ("error" in found) return found;
    id = found.id;
  }
  const session = store.load(id);
  return session ?? { error: `no chat with id ${wanted}` };
}
