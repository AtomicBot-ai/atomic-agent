/**
 * ATO-2447: before a CLI starts on the bare local model, ask serve's
 * `/local/v1/models` whether the model answers and what it is called.
 * One request settles everything the person would otherwise find out
 * from the CLI's first error: the key is wrong, the serve is too old to
 * have the route, or no model is loaded.
 */

const PROBE_TIMEOUT_MS = 5_000;

export type LocalModelProbe =
  /** `modelId`: the first model the server lists, when it names one. */
  | { readonly ok: true; readonly modelId: string | null }
  | { readonly ok: false; readonly reason: "auth" | "no_route" | "not_running" | "unreachable" };

/** The model id of an OpenAI `GET /v1/models` answer (llama-server also sends `models[].name`). */
export function firstModelId(body: unknown): string | null {
  const b = body as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] } | null;
  const id = b?.data?.[0]?.id ?? b?.models?.[0]?.model ?? b?.models?.[0]?.name;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

export async function probeLocalModel(
  serveBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalModelProbe> {
  let res: Response;
  try {
    res = await fetchImpl(`${serveBaseUrl}/local/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
  if (res.status === 404) return { ok: false, reason: "no_route" };
  if (!res.ok) return { ok: false, reason: "not_running" };
  try {
    return { ok: true, modelId: firstModelId(await res.json()) };
  } catch {
    return { ok: true, modelId: null };
  }
}

/** What to tell the person when the probe failed; `port` is the serve's. */
export function localModelProbeMessage(reason: Exclude<LocalModelProbe, { ok: true }>["reason"], port: number): string {
  switch (reason) {
    case "auth":
      return (
        `launch: the atag serve on port ${port} does not accept the key from ATOMIC_AGENT_API_KEY or ` +
        "<stateDir>/serve-api.key (it was started with another --api-key). Set ATOMIC_AGENT_API_KEY to that key.\n"
      );
    case "no_route":
      return (
        `launch: the atag serve on port ${port} is from an older Atomic Agent and cannot pass requests to the local model.\n` +
        "Restart it (stop it, then run atag serve again), or run this with --agent.\n"
      );
    case "not_running":
      return "launch: the local model is not running. Start it with: atag models start (or in the Atomic Agent app), then run this again.\n";
    case "unreachable":
      return `launch: the atag serve on port ${port} stopped answering.\n`;
  }
}
