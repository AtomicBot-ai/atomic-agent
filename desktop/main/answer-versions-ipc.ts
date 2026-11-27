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
 *
 * ATO-2470: and the routes for every version of every question (edited
 * messages, answers to earlier questions), message-versions.ts:
 *
 *   agent:messageVersions   the questions that have another version
 *   agent:switchVersion     put one of them in the chat
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
import {
  messageVersionsAnswer,
  switchVersionAnswer,
  switchVersionBody,
  type MessageVersionsAnswer,
  type SwitchVersionAnswer,
} from "./message-versions.js";

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
  ipcMain.handle("agent:messageVersions", async (_event, payload: unknown): Promise<MessageVersionsAnswer> => {
    const { sessionId } = (payload ?? {}) as { sessionId?: unknown };
    if (typeof sessionId !== "string" || !sessionId) return NOT_SAVED;
    try {
      const res = await client.sessionRoute(sessionId, "message-versions", "GET", undefined, 15_000);
      return messageVersionsAnswer(res.status, res.body);
    } catch (err) {
      return { ok: false, supported: true, error: requestErrorText(err) };
    }
  });
  ipcMain.handle("agent:switchVersion", async (_event, payload: unknown): Promise<SwitchVersionAnswer> => {
    const { sessionId, priorQuestions, expectText, ref } = (payload ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) return NOT_SAVED;
    const body = switchVersionBody(priorQuestions, expectText, ref);
    if (body === null) return { ok: false, supported: true, code: "no_version", error: "No such version" };
    try {
      const res = await client.sessionRoute(sessionId, "switch-version", "POST", body, 30_000);
      return switchVersionAnswer(res.status, res.body);
    } catch (err) {
      return { ok: false, supported: true, error: requestErrorText(err) };
    }
  });
}
