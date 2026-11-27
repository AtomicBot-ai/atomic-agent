import { checkLlamaServer } from "../llm/llama-server-health.js";
import { isLocalRequest } from "./auth-throttle.js";
import { sendJson, type HttpHandler } from "./request-context.js";
import type { BusyTurn } from "../runtime/turn-controller.js";

/** `::ffff:127.0.0.1` is how a v4 loopback peer shows up on a v6 socket. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const addr = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.");
}

/**
 * `GET /health` — liveness probe. Reports the sidecar's own status plus
 * a passthrough summary of the external llama-server reachability.
 *
 * The llama probe is a single attempt on purpose. This route used to
 * inherit `checkLlamaServer`'s full retry ladder (5 attempts with
 * exponential backoff — 15.5 s worst case), which is the one budget a
 * liveness endpoint does not have: orchestrators typically allow 1–10 s
 * before declaring the process dead, so the slow answer read as a hang
 * and restart-looped the sidecar exactly when llama was down. Retrying
 * inside one probe buys nothing anyway — the orchestrator's next poll
 * IS the retry.
 *
 * Status contract:
 * - HTTP 200, `status: "ok"`       — sidecar up, llama reachable.
 * - HTTP 200, `status: "degraded"` — sidecar up, llama down. Still 200
 *   by default: the LLM runtime may legally be absent (indexing,
 *   degraded mode), and restarting the sidecar would not revive llama.
 * - `?strict=1` turns the degraded case into HTTP 503 for orchestrators
 *   that do want restart-on-down semantics.
 *
 * `pid`, `ppid` and `busyTurns` are here for `serve --reap`, which has
 * to decide whether a process it found on record is a stranded server
 * it may signal. Node cannot read another process's parent, so the
 * server reports its own; taken together with `runtime` and `pid` this
 * one response answers identity, abandonment and idleness, which is
 * what keeps the sweep from ever signalling on a recycled pid.
 *
 * `?llama=0` leaves the llama probe out: the caller asks only after the
 * agent itself — the desktop asks `busyTurns` before every switch, and a
 * closed model-server port costs about two seconds to refuse on Windows.
 * `status` is then the sidecar's own (`ok`), and `llama.reachable` is null.
 *
 * They are answered **only to loopback**. `workingDir` is static
 * configuration, but `busyTurns` is live behaviour — on `--host 0.0.0.0`
 * it would be an activity oracle for the whole network, which is a new
 * kind of disclosure for a route that is public by design. The sweep
 * only ever probes 127.0.0.1, so it loses nothing. A loopback request
 * that carries `cf-connecting-ip` came in through a cloudflared tunnel
 * (`atag pair --remote`, ATO-2308) and is treated as remote.
 *
 * `busyTurnOrigins` (ATO-2519) says where each of those turns came from,
 * one entry per turn: `{ origin }` is the channel (`telegram`, `discord`,
 * `slack`, ...), `http` for the OpenAI-compatible and AG-UI routes (the
 * desktop's own chats among them), `scheduler` with `wakeReason` for a
 * task's turn. It is additive: `busyTurns` stays the count the sweep and
 * older desktops read, taken from the same snapshot. Session ids are left
 * out on purpose; a caller needs the kinds, not which chats.
 */
export function createHealthHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const llama =
      params.get("llama") === "0"
        ? { reachable: null, latencyMs: null, error: null }
        : await checkLlamaServer({ retries: 0 });
    const strict = params.get("strict") === "1";
    const degraded = llama.reachable === false;
    sendJson(res, degraded && strict ? 503 : 200, {
      status: degraded ? "degraded" : "ok",
      runtime: "atomic-agent",
      ...(isLocalRequest(req)
        ? {
            pid: process.pid,
            ppid: process.ppid,
            ...busyTurnFields(ctx.runtime.turnController.busyTurns()),
          }
        : {}),
      workingDir: ctx.runtime.capabilities.workingDir,
      llama: {
        url: ctx.runtime.config.localModels.url,
        reachable: llama.reachable,
        latencyMs: llama.latencyMs,
        error: llama.error,
      },
    });
  };
}

/** ATO-2519: `busyTurns` and `busyTurnOrigins` out of one snapshot, so the count and the list agree. */
export function busyTurnFields(turns: readonly BusyTurn[]): {
  busyTurns: number;
  busyTurnOrigins: Array<{ origin: string; wakeReason?: string }>;
} {
  return {
    busyTurns: turns.length,
    busyTurnOrigins: turns.map((t) => ({ origin: t.origin, ...(t.wakeReason ? { wakeReason: t.wakeReason } : {}) })),
  };
}
