/**
 * Settings › Performance (issue #996): the agent's
 * `GET /api/local-model/performance`, said to the window as exactly one of
 *
 *   { ok: true, data }                          200, the agent's body
 *   { ok: false, kind: "unsupported" }          404: an agent from before the route
 *   { ok: false, kind: "unreachable", error }   anything else: a transport
 *                                               failure, the timeout, another
 *                                               status, a body that is not JSON,
 *                                               the agent not started
 *
 * so the pane can tell "update the agent" from "the agent is not answering".
 * The fetch itself is AgentClient.localPerformance(); it answers
 * `{status, body}` rather than throwing on a non-2xx status.
 *
 * Pure: the fetch is handed in, so the unit test drives it.
 */

export type LocalPerformanceResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; kind: "unsupported" }
  | { ok: false; kind: "unreachable"; error: string };

export async function localPerformanceResult(
  get: () => Promise<{ status: number; body: unknown }>,
): Promise<LocalPerformanceResult> {
  try {
    const { status, body } = await get();
    if (status === 404) return { ok: false, kind: "unsupported" };
    if (status !== 200) return { ok: false, kind: "unreachable", error: `HTTP ${status}` };
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, kind: "unreachable", error: "the agent's answer is not a performance report" };
    }
    return { ok: true, data: body as Record<string, unknown> };
  } catch (err) {
    return { ok: false, kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
  }
}
