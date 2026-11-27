/**
 * ATO-2485: the terminal panel's routes (renderer/agent-jobs.js).
 *
 *   agentJobs:list    the chat's shell jobs  (GET  /api/sessions/{id}/shell-jobs)
 *   agentJobs:output  output from a position (GET  …/shell-jobs/{jobId}/output)
 *   agentJobs:input   the person's typing    (POST …/shell-jobs/{jobId}/input)
 *   agentJobs:stop    stop one job           (POST …/shell-jobs/{jobId}/stop)
 *
 * Each answers { ok: true, data } with the agent's own answer, or
 * { ok: false, error, unsupported } in words the panel shows. The typed
 * text is passed through and never logged, kept or reported.
 */

import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import {
  agentJobAddressOf,
  agentJobErrorOf,
  agentJobInputOf,
  agentJobSessionOf,
  agentJobSinceOf,
} from "./agent-jobs.js";

type Answer = { ok: true; data: unknown } | { ok: false; error: string; unsupported: boolean };

async function answer(call: () => Promise<unknown>): Promise<Answer> {
  try {
    return { ok: true, data: await call() };
  } catch (err) {
    return { ok: false, ...agentJobErrorOf(err) };
  }
}

const gone: Answer = { ok: false, error: "That job is not open any more", unsupported: false };

export function wireAgentJobsIpc(client: AgentClient): void {
  ipcMain.handle("agentJobs:list", async (_event, sessionId: unknown): Promise<Answer> => {
    const id = agentJobSessionOf(sessionId);
    if (!id) return { ok: false, error: "No chat yet", unsupported: false };
    return answer(() => client.shellJobs(id));
  });

  ipcMain.handle("agentJobs:output", async (_event, payload: unknown): Promise<Answer> => {
    const a = agentJobAddressOf(payload);
    if (!a) return gone;
    const since = agentJobSinceOf((payload as { since?: unknown } | null)?.since);
    return answer(() => client.shellJobOutput(a.sessionId, a.jobId, since));
  });

  ipcMain.handle("agentJobs:input", async (_event, payload: unknown): Promise<Answer> => {
    const req = agentJobInputOf(payload);
    if (!req.ok) return { ok: false, error: req.error, unsupported: false };
    return answer(() => client.shellJobInput(req.address.sessionId, req.address.jobId, req.text, req.eof));
  });

  ipcMain.handle("agentJobs:stop", async (_event, payload: unknown): Promise<Answer> => {
    const a = agentJobAddressOf(payload);
    if (!a) return gone;
    return answer(() => client.stopShellJob(a.sessionId, a.jobId));
  });
}
