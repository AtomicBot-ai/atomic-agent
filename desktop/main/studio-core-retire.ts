/**
 * ATO-1351 / ATO-1352: on quit, an Atomic Chat Core that Studio started or
 * joined is asked to exit when it serves nothing.
 *
 * Until now the only thing that retired Core at quit was the agent's
 * `models stop` (main.ts stopLocalDaemonOnQuit), and it ran only for a
 * managed setup with stopOnExit on. With the chat model on an external
 * server, or stopOnExit off, a Core that Studio brought up kept running
 * after the app was gone. And even on the managed path Core refused that
 * stop while Studio's own client lease was still held (it is let go a
 * minute after the last job, studio-media.ts LEASE_GRACE_MS), so quitting
 * soon after a generation left it up too.
 *
 * Mirrors src/local-llm/core/core-idle.ts `shutdownIdleCoreClient` (the
 * desktop is a separate build): Core stays when it still has a model
 * session (a chat model kept warm by stopOnExit off, the terminal agent's
 * model), an enabled embedding module, or another client attached. Core's
 * own `/shutdown` checks the other leases and closes admission in one step.
 * Never force, never signal a PID. Taken under the engine operation lock,
 * waited for briefly: a quit does not wait out someone else's model load.
 */

import { connectStudioCore, withStudioOperation } from "./studio-core-start.js";
import type { StudioCoreClient } from "./studio-core-client.js";

/** How long the quit waits for another holder of the engine operation lock. */
const RETIRE_LOCK_WAIT_MS = 2_000;
/** Each Core call on the way: a quit never waits on Core's usual 15 s. */
const RETIRE_CALL_MS = 3_000;

/** Ask a connected Core to exit when it serves nothing. False, leaving it running, otherwise. */
export async function shutdownIdleStudioClient(client: StudioCoreClient): Promise<boolean> {
  const opts = { timeoutMs: RETIRE_CALL_MS };
  const lease = await client.call<{ client: { id: string } }>("/clients", { name: "Atomic Agent Studio (quit)", pid: process.pid }, opts);
  const id = lease.client.id;
  let stopping = false;
  try {
    const snap = await client.call<{ sessions?: unknown[] }>("/snapshot", undefined, opts);
    if (!Array.isArray(snap.sessions) || snap.sessions.length > 0) return false;
    // The embedding module is no session, yet a model someone turned on.
    // An older Core without the module answers 404: nothing to keep.
    const embedding = await client.call<{ enabled?: boolean }>("/embedding/status", undefined, opts).catch(() => null);
    if (embedding?.enabled) return false;
    await client.call<{ ok: boolean }>("/shutdown", { client_id: id }, opts);
    stopping = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!stopping) await client.call(`/clients/${encodeURIComponent(id)}`, undefined, { method: "DELETE", timeoutMs: RETIRE_CALL_MS }).catch(() => {});
  }
}

/**
 * The running Core of `version` in `dataDir`, retired when idle. Never
 * starts or installs one, never throws: false when none is running, it is
 * someone else's (another version, scope or folder), busy, or slow.
 */
export async function retireIdleStudioCore(dataDir: string, version: string, request?: typeof fetch): Promise<boolean> {
  try {
    return await withStudioOperation(dataDir, async () => {
      const client = await connectStudioCore(dataDir, version, request).catch(() => null);
      return client ? shutdownIdleStudioClient(client) : false;
    }, RETIRE_LOCK_WAIT_MS);
  } catch {
    return false;
  }
}
