/**
 * ATO-2485: what the window may ask of the agent's shell jobs, checked
 * before it reaches the agent (agent-jobs-ipc.ts), and the agent's
 * refusals in words the terminal panel shows.
 *
 * The agent owns the jobs (`os.shell.run`, `tty: true`) and decides the
 * rest (src/http/route-shell-jobs.ts). Nothing here keeps or logs what
 * the person types.
 */

/** The agent's own cap (SHELL_JOB_INPUT_MAX_CHARS). */
export const AGENT_JOB_INPUT_MAX_CHARS = 8_192;

export interface AgentJobAddress {
  sessionId: string;
  jobId: number;
}

export function agentJobSessionOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 200 && !/[\r\n\x00/]/.test(raw) ? raw : null;
}

export function agentJobAddressOf(payload: unknown): AgentJobAddress | null {
  const { sessionId, jobId } = (payload ?? {}) as { sessionId?: unknown; jobId?: unknown };
  const id = agentJobSessionOf(sessionId);
  if (!id || typeof jobId !== "number" || !Number.isInteger(jobId) || jobId < 1) return null;
  return { sessionId: id, jobId };
}

/** `since` as the agent takes it: a whole number from 0, else 0. */
export function agentJobSinceOf(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export type AgentJobInput =
  | { ok: true; address: AgentJobAddress; text: string; eof: boolean }
  | { ok: false; error: string };

export function agentJobInputOf(payload: unknown): AgentJobInput {
  const address = agentJobAddressOf(payload);
  if (!address) return { ok: false, error: "That job is not open any more" };
  const { text, eof } = (payload ?? {}) as { text?: unknown; eof?: unknown };
  if (typeof text !== "string") return { ok: false, error: "Nothing to send" };
  const end = eof === true;
  if (text.length === 0 && !end) return { ok: false, error: "Nothing to send" };
  if (text.length > AGENT_JOB_INPUT_MAX_CHARS) return { ok: false, error: "That is too long to send in one go" };
  return { ok: true, address, text, eof: end };
}

/**
 * The agent's refusal in the panel's words. `unsupported` marks an agent
 * from before the routes, so the panel stops asking.
 */
export function agentJobErrorOf(err: unknown): { error: string; unsupported: boolean } {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/^no route for /i.test(text) || /does not expose shell jobs/i.test(text)) {
    return { error: "This version of the agent can't share its terminal. Update Atomic Agent.", unsupported: true };
  }
  if (/^no job \d+/i.test(text)) return { error: "This job has ended.", unsupported: false };
  if (/does not take input/i.test(text)) {
    return { error: "This job doesn't take typing: it has ended or wasn't started as a terminal.", unsupported: false };
  }
  if (/too much to type/i.test(text)) return { error: "That is too long to send in one go.", unsupported: false };
  if (/paired phone/i.test(text)) return { error: "Typing into the agent's jobs works on this computer only.", unsupported: false };
  return { error: "The agent did not answer. Try again.", unsupported: false };
}
