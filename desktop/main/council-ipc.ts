/**
 * ATO-2432: `/council`, the model council (renderer/council-view.js).
 *
 *   agent:council       { id, question, models?, judge?, chairman?, rank?, maxUsd?, dryRun? }
 *                       -> POST /api/council; resolves with the outcome
 *   agent:council-stop  { id } -> aborts that council's request
 *   agent:council-frame (to the window that asked) { id, event, data } per SSE frame
 *
 * Nothing is saved: the agent writes no session, and the window keeps the
 * verdict in a card until it is closed.
 */

import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { councilRequest, runCouncilRequest } from "./council-client.js";

export function wireCouncilIpc(client: AgentClient): void {
  const running = new Map<string, AbortController>();
  ipcMain.handle("agent:council", async (event, payload: unknown) => {
    const req = councilRequest(payload);
    if (!req.ok) return { ok: false, supported: true, error: req.error };
    const id = String((payload as { id?: unknown } | null)?.id ?? "");
    const controller = new AbortController();
    if (id) {
      running.get(id)?.abort();
      running.set(id, controller);
    }
    try {
      return await runCouncilRequest(() => client.filesTarget(), req.body, {
        signal: controller.signal,
        onFrame: (frame) => {
          if (!event.sender.isDestroyed()) event.sender.send("agent:council-frame", { id, ...frame });
        },
      });
    } finally {
      if (id && running.get(id) === controller) running.delete(id);
    }
  });
  ipcMain.handle("agent:council-stop", (_event, payload: unknown) => {
    const id = String((payload as { id?: unknown } | null)?.id ?? "");
    running.get(id)?.abort();
    running.delete(id);
    return true;
  });
}
