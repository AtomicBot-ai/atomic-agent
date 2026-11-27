/**
 * ATO-2114: the window's routes for the "‹ 2/3 ›" switcher under the last
 * reply (renderer/answer-versions.js), passed to the agent's previous-replies
 * routes (answer-versions.ts says which and how the answer is read):
 *
 *   agent:previousReplies        the earlier answers kept for the last question
 *   agent:restorePreviousReply   put one of them back in place of the one on screen
 *
 * The window names the chat and, for a restore, the kept answer's index;
 * nothing else reaches the agent.
 */

import { ipcMain } from "electron";

import { requestErrorText, type AgentClient } from "./agent-client.js";
import {
  previousRepliesAnswer,
  restoreReplyAnswer,
  restoreReplyBody,
  type PreviousRepliesAnswer,
  type RestoreReplyAnswer,
} from "./answer-versions.js";

const NOT_SAVED = { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" } as const;

export function wireAnswerVersionsIpc(client: Pick<AgentClient, "sessionRoute">): void {
  ipcMain.handle("agent:previousReplies", async (_event, payload: unknown): Promise<PreviousRepliesAnswer> => {
    const { sessionId } = (payload ?? {}) as { sessionId?: unknown };
    if (typeof sessionId !== "string" || !sessionId) return NOT_SAVED;
    try {
      const res = await client.sessionRoute(sessionId, "previous-replies", "GET", undefined, 15_000);
      return previousRepliesAnswer(res.status, res.body);
    } catch (err) {
      return { ok: false, supported: true, error: requestErrorText(err) };
    }
  });
  ipcMain.handle("agent:restorePreviousReply", async (_event, payload: unknown): Promise<RestoreReplyAnswer> => {
    const { sessionId, index } = (payload ?? {}) as { sessionId?: unknown; index?: unknown };
    if (typeof sessionId !== "string" || !sessionId) return NOT_SAVED;
    const body = restoreReplyBody(index);
    if (body === null) return { ok: false, supported: true, code: "bad_index", error: "No such answer" };
    try {
      const res = await client.sessionRoute(sessionId, "restore-previous-reply", "POST", body, 30_000);
      return restoreReplyAnswer(res.status, res.body);
    } catch (err) {
      return { ok: false, supported: true, error: requestErrorText(err) };
    }
  });
}
