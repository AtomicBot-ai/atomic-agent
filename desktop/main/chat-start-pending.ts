import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ATO-421: the agent's "a chat model start is on its way" marker,
 * `<models data dir>/chat-start.pending` holding the starter's pid
 * (src/local-llm/server/chat-start-pending.ts, which the desktop cannot
 * import). A turn that meets the refused port reads a start under a live
 * owner's marker as on its way, not as a dead engine it gives up on after
 * 8 s. The `models start` the supervisor spawns writes its own marker, but
 * only once it has booted; on Windows that boot ate most of the turn's
 * grace. The supervisor's restart holds this one from the moment it
 * decides to restart, and the agent's own marker takes over in the file.
 */
export const CHAT_START_PENDING_FILE = "chat-start.pending";

/**
 * Write the marker and answer the undo. The undo removes the file only
 * while it still names this process: a `models start` that overwrote it
 * with its own pid owns it from then on. Never throws, either way: a
 * marker that cannot be written leaves the restart as it was.
 */
export function markChatStartPending(dataDir: string, pid: number = process.pid): () => void {
  const path = join(dataDir, CHAT_START_PENDING_FILE);
  try {
    writeFileSync(path, String(pid), { mode: 0o600 });
  } catch {
    /* the restart goes on without its marker */
  }
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    try {
      if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}
