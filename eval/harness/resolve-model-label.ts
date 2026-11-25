/**
 * Name of the model under test, for the attack report header.
 *
 * Order: `ATOMIC_AGENT_EVAL_MODEL_ID` (set by `run-full-eval.mjs` from
 * `atomic-agent models status` in managed mode, or by hand), then the
 * llama-server at `ATOMIC_AGENT_EVAL_LLAMA_URL`: `/v1/models` first,
 * `/props` second. Never throws; an unreachable server gives a label
 * that says so, because a report without a model name is still worth
 * keeping.
 */

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

const PROBE_TIMEOUT_MS = 3_000;

export async function resolveModelLabel(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const pinned = env.ATOMIC_AGENT_EVAL_MODEL_ID?.trim();
  if (pinned) return pinned;
  const raw = env.ATOMIC_AGENT_EVAL_LLAMA_URL?.trim();
  if (!raw) return "unknown (ATOMIC_AGENT_EVAL_LLAMA_URL not set)";
  const base = raw.replace(/\/+$/, "").replace(/\/v1$/, "");

  const models = await probe(fetchImpl, `${base}/v1/models`);
  const fromModels = firstModelId(models);
  if (fromModels) return fromModels;

  const props = await probe(fetchImpl, `${base}/props`);
  const fromProps = modelFromProps(props);
  if (fromProps) return fromProps;

  return `unknown (no model name from ${base})`;
}

async function probe(fetchImpl: FetchLike, url: string): Promise<unknown> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function firstModelId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const id = (data[0] as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function modelFromProps(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { model_alias: alias, model_path: path } = body as { model_alias?: unknown; model_path?: unknown };
  if (typeof alias === "string" && alias.length > 0) return alias;
  if (typeof path === "string" && path.length > 0) return path.split(/[\\/]/).pop() ?? path;
  return null;
}
