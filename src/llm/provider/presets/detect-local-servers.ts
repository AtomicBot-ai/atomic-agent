/**
 * Find model servers already running on this computer (ATO-2013, ATO-2168):
 * Ollama on 11434, LM Studio on 1234, and llama.cpp's own server on 9931,
 * which is where the Llama desktop app (llama.app) and a current
 * `llama-server` listen by default. Setup lists what it finds first, the way
 * Continue, Open WebUI and Jan pick up a running Ollama or LM Studio and
 * OpenClaw offers the Llama app first in onboarding.
 *
 * Every probe is one GET with a short timeout against a loopback address,
 * all of them in parallel, so a machine with nothing running costs one
 * refused connection per port and the whole check stays under a second.
 * Nothing here writes config or reads it; the caller decides what to show.
 */

/** Which kind of server answered. */
export type LocalServerKind = "ollama" | "lmstudio" | "llama-app";

export interface DetectedLocalServer {
  readonly kind: LocalServerKind;
  /** What the setup screens call it. */
  readonly label: string;
  /** The address that answered, without a trailing `/v1`. */
  readonly baseUrl: string;
  /**
   * The provider preset that connects to it (`provider-presets.ts`), or
   * `null` for llama.cpp, which goes in as the External llama-server
   * (`localModels.url`) rather than as a provider.
   */
  readonly presetId: "ollama" | "lmstudio" | null;
  /** Model ids the server lists, in its own order. May be empty. */
  readonly models: readonly string[];
  /**
   * Models already loaded in memory, where the server says (Ollama's
   * `/api/ps`). Empty when nothing is loaded or the server does not say.
   */
  readonly loaded: readonly string[];
}

/** One address to try and how to read its answer. */
export interface LocalServerTarget {
  readonly kind: LocalServerKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly presetId: DetectedLocalServer["presetId"];
  /** Path of the model list on that server. */
  readonly modelsPath: string;
  /** Path that lists loaded models, when the server has one. */
  readonly loadedPath?: string;
}

/**
 * The default addresses, in the order setup recommends them: llama.cpp
 * first (the engine this agent is built around, and what OpenClaw puts
 * first), then Ollama, then LM Studio. 127.0.0.1 rather than localhost:
 * Node may resolve localhost to ::1 first, and Ollama binds IPv4 only.
 */
export const LOCAL_SERVER_TARGETS: readonly LocalServerTarget[] = [
  {
    kind: "llama-app",
    label: "Llama app (llama.cpp)",
    baseUrl: "http://127.0.0.1:9931",
    presetId: null,
    modelsPath: "/v1/models",
  },
  {
    kind: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    presetId: "ollama",
    modelsPath: "/api/tags",
    loadedPath: "/api/ps",
  },
  {
    kind: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234",
    presetId: "lmstudio",
    modelsPath: "/v1/models",
  },
];

/** Short enough that setup never waits on it; loopback answers in a few ms. */
export const DETECT_TIMEOUT_MS = 800;

export interface DetectLocalServersOptions {
  /** Test seam; the global `fetch` by default. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly targets?: readonly LocalServerTarget[];
  /** Abandons every probe (the screen that asked was closed). */
  readonly signal?: AbortSignal;
}

function stringIds(list: unknown, field: "id" | "name" | "model"): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const value = (item as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

/**
 * Model ids from a model-list body, or `null` when the body is not the
 * shape this server kind answers with. A wrong shape means some other
 * program holds the port, and it must not be offered as a model server.
 */
export function readModelIds(kind: LocalServerKind, body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (kind === "ollama") {
    // GET /api/tags: { models: [{ name, model, ... }] }
    if (!Array.isArray(record.models)) return null;
    const names = stringIds(record.models, "name");
    return names.length > 0 ? names : stringIds(record.models, "model");
  }
  // OpenAI shape: { object: "list", data: [{ id }] } (LM Studio, llama-server).
  if (!Array.isArray(record.data)) return null;
  return stringIds(record.data, "id");
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

function probeSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([timeout, outer]) : timeout;
}

async function probeTarget(
  target: LocalServerTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<DetectedLocalServer | null> {
  try {
    const body = await getJson(
      fetchImpl,
      `${target.baseUrl}${target.modelsPath}`,
      probeSignal(timeoutMs, outer),
    );
    const models = readModelIds(target.kind, body);
    if (models === null) return null;
    let loaded: string[] = [];
    if (target.loadedPath) {
      try {
        const ps = await getJson(
          fetchImpl,
          `${target.baseUrl}${target.loadedPath}`,
          probeSignal(timeoutMs, outer),
        );
        loaded = readModelIds(target.kind, ps) ?? [];
      } catch {
        // The list answered; a failed "what is loaded" only loses the hint.
      }
    }
    return {
      kind: target.kind,
      label: target.label,
      baseUrl: target.baseUrl,
      presetId: target.presetId,
      models,
      loaded,
    };
  } catch {
    // Refused, timed out or not JSON: nothing usable runs there.
    return null;
  }
}

/**
 * Probe every target in parallel and return the ones that answered like
 * the server they are named for, in `targets` order. Never throws.
 */
export async function detectLocalServers(
  options: DetectLocalServersOptions = {},
): Promise<DetectedLocalServer[]> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS;
  const targets = options.targets ?? LOCAL_SERVER_TARGETS;
  const results = await Promise.all(
    targets.map((target) => probeTarget(target, fetchImpl, timeoutMs, options.signal)),
  );
  return results.filter((r): r is DetectedLocalServer => r !== null);
}

/**
 * One short phrase per server for a setup screen: `Ollama (3 models, 1
 * loaded)`. Plain ASCII and no long dashes, so it measures as it prints.
 */
export function describeDetectedServer(server: DetectedLocalServer): string {
  const n = server.models.length;
  const parts = [n === 1 ? "1 model" : `${n} models`];
  if (server.loaded.length > 0) parts.push(`${server.loaded.length} loaded`);
  return `${server.label} (${parts.join(", ")})`;
}
