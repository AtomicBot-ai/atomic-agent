/**
 * ATO-1040 — the goal card's routes (renderer/goal-card.js, goal-actions.js).
 *
 *   goal:get      the chat's stored goal (GET /api/sessions/{id}/goal)
 *   goal:action   set / pause / resume / clear (POST /api/sessions/{id}/goal)
 *
 * Both answer { ok: true, data } with the agent's own answer, or
 * { ok: false, error } in words the window shows as they are.
 */

import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { goalErrorText, goalIpcRequest, goalSessionIdOf } from "./session-goal.js";

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

export function wireSessionGoalIpc(client: AgentClient): void {
  ipcMain.handle("goal:get", async (_event, payload: unknown): Promise<Answer> => {
    const id = goalSessionIdOf((payload as { sessionId?: unknown } | null)?.sessionId);
    if (!id) return { ok: false, error: "No chat yet" };
    try {
      return { ok: true, data: await client.sessionGoal(id) };
    } catch (err) {
      return { ok: false, error: goalErrorText(err) };
    }
  });

  ipcMain.handle("goal:action", async (_event, payload: unknown): Promise<Answer> => {
    const req = goalIpcRequest(payload);
    if (!req.ok) return { ok: false, error: req.error };
    try {
      return { ok: true, data: await client.sessionGoalAction(req.sessionId, req.body) };
    } catch (err) {
      return { ok: false, error: goalErrorText(err) };
    }
  });
}
