/**
 * ATO-1056 / ATO-1058 — the window's routes for "Roll back here", "Edit" and
 * "Fork from here" (renderer/chat-rewind.js), passed to the agent's rewind and
 * fork routes (chat-rewind.ts says which and how the answer is read):
 *
 *   agent:rewindPreview   what rolling back to a question would change
 *   agent:rewind          roll back: the agent puts the files back, then cuts the chat
 *                         (`files: false` the chat only, `conversation: false` the files only)
 *   agent:forkSession     a new chat with the history through that question's answer
 *
 * The window names the chat and the question; nothing else reaches the agent.
 */

import { ipcMain } from "electron";

import { requestErrorText, type AgentClient } from "./agent-client.js";
import { rewindAnswer, rewindRequestBody, type RewindAnswer, type RewindRoute } from "./chat-rewind.js";

const CHANNELS: ReadonlyArray<[string, RewindRoute]> = [
  ["agent:rewindPreview", "rewind/preview"],
  ["agent:rewind", "rewind"],
  ["agent:forkSession", "fork"],
];

export function wireChatRewindIpc(client: Pick<AgentClient, "sessionRoute">): void {
  for (const [channel, route] of CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown): Promise<RewindAnswer> => {
      const { sessionId, priorQuestions, expectText, files, conversation, keepBranch } = (payload ?? {}) as { sessionId?: unknown; priorQuestions?: unknown; expectText?: unknown; files?: unknown; conversation?: unknown; keepBranch?: unknown };
      if (typeof sessionId !== "string" || !sessionId) return { ok: false, supported: true, code: "session_not_found", error: "This chat is not saved yet" };
      // Only a rollback takes `files` (ATO-1056: Edit, files and conversation or the conversation only)
      // and `conversation` (ATO-2112: Roll back, files only).
      const rollback = route === "rewind";
      // ATO-2470: an Edit keeps the rows it cuts as a version of the message (`keepBranch`).
      const body = rewindRequestBody(priorQuestions, expectText, rollback ? files : undefined, rollback ? conversation : undefined, rollback ? keepBranch : undefined);
      if (body === null) return { ok: false, supported: true, error: "No message to go back to" };
      try {
        const res = await client.sessionRoute(sessionId, route, "POST", body);
        return rewindAnswer(res.status, res.body);
      } catch (err) {
        return { ok: false, supported: true, error: requestErrorText(err) };
      }
    });
  }
}
