import type { CoreControlClient } from "./core-client.js";

/**
 * Ask a connected Core to shut down when it serves nothing. Returns false,
 * leaving Core running, when it still has a model session, an enabled
 * embedding module, or another client is attached: Core's own `/shutdown`
 * checks the other leases and closes admission in one step. Never force,
 * never signal a PID. The caller holds the engine operation lock.
 */
export async function shutdownIdleCoreClient(client: CoreControlClient): Promise<boolean> {
  const lease = await client.call<{ client: { id: string } }>("/clients", { name: "Atomic Agent", pid: process.pid });
  const id = lease.client.id;
  let stopping = false;
  try {
    if ((await client.snapshot()).sessions.length > 0) return false;
    // The embedding module is no session, yet a model someone turned on.
    // An older Core without the module answers 404: nothing to keep.
    const embedding = await client.call<{ enabled?: boolean }>("/embedding/status").catch(() => null);
    if (embedding?.enabled) return false;
    await client.call<{ ok: boolean }>("/shutdown", { client_id: id });
    stopping = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!stopping) await client.call(`/clients/${encodeURIComponent(id)}`, undefined, { method: "DELETE" }).catch(() => {});
  }
}
