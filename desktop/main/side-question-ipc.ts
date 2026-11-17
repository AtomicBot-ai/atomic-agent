/**
 * ATO-1152 — `/btw`, the side question (renderer/side-question.js).
 *
 *   agent:btw   { question, sessionId? } -> POST /api/btw
 *
 * Answers what AgentClient.askSideQuestion answers: { ok: true, supported,
 * text } or { ok: false, supported, error }. Nothing is saved anywhere:
 * the agent only reads the chat, and the window keeps the answer in a card
 * until it is closed.
 */

import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { sideQuestionRequest } from "./side-question.js";

export function wireSideQuestionIpc(client: AgentClient): void {
  ipcMain.handle("agent:btw", async (_event, payload: unknown) => {
    const req = sideQuestionRequest(payload);
    if (!req.ok) return { ok: false, supported: true, error: req.error };
    return client.askSideQuestion(req.question, req.sessionId);
  });
}
