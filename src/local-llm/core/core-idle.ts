import type { CoreControlClient } from "./core-client.js";

/**
 * Ask a connected Core to shut down when it serves nothing. Returns false,
 * leaving Core running, when it still has a model session, an enabled
 * embedding module, a loaded diffusion model (ATO-812: the desktop's Studio
 * keeps one warm after a generation and lets its own client lease go a
 * minute later), or another client is attached: Core's own `/shutdown`
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
    // Nor is a diffusion model. The agent's own media tools are cloud only, so
    // a loaded one is Studio's; a Core without the module answers 404.
    if (diffusionModelLoaded(await client.call<DiffusionStatus>("/diffusion/status").catch(() => null))) return false;
    await client.call<{ ok: boolean }>("/shutdown", { client_id: id });
    stopping = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!stopping) await client.call(`/clients/${encodeURIComponent(id)}`, undefined, { method: "DELETE" }).catch(() => {});
  }
}

/** The part of Core's `GET /diffusion/status` this reads (desktop/main/studio-local-models.ts reads the same). */
interface DiffusionStatus { model?: { loaded?: { modelId?: string } | null } | null }

/** A diffusion model sits in Core's memory. */
export function diffusionModelLoaded(status: DiffusionStatus | null): boolean {
  const id = status?.model?.loaded?.modelId;
  return typeof id === "string" && id.length > 0;
}
