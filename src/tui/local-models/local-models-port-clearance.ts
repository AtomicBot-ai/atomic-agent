import type { getConfig } from "../../config/index.js";
import {
  describeReclaim,
  reclaimManagedPort,
  type EmbeddingDaemonStartOptions,
  type ReclaimOutcome,
  type ReclaimRequest,
} from "../../local-llm/index.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";

type Config = ReturnType<typeof getConfig>;

export interface PortClearanceDeps {
  /** One feed line per decision. */
  say: (line: string) => void;
  reclaim?: (req: ReclaimRequest) => Promise<ReclaimOutcome>;
  persist?: typeof persistUserLocalModelsConfig;
  /** The chat route's URL moved: rebuild the provider and the poller. */
  onChatPortMoved?: (url: string) => void | Promise<void>;
}

export interface ChatClearance {
  port: number;
  /** Set when our own daemon already serves the model — nothing to start. */
  adoptedPid: number | null;
}

/**
 * Clear the chat daemon's port before a start (see `reclaimManagedPort`
 * for the rules). A move is written to `localModels.managed.port` — the
 * provider URL follows it in the same write — so the next launch goes
 * straight to the free port and the running route is rebuilt now.
 */
export async function clearChatPort(
  cfg: Config,
  modelId: string,
  deps: PortClearanceDeps,
): Promise<ChatClearance> {
  const port = cfg.localModels.managed.port;
  const outcome = await (deps.reclaim ?? reclaimManagedPort)({
    port,
    role: "chat",
    ownDataDir: cfg.paths.localModelsDataDir,
    alias: modelId,
    avoidPorts: [cfg.localModels.embeddings.port],
  });
  const line = describeReclaim(outcome, "chat server", port);
  if (line) deps.say(line);
  if (outcome.kind === "adopted") return { port, adoptedPid: outcome.pid };
  if (outcome.kind !== "moved") return { port, adoptedPid: null };
  (deps.persist ?? persistUserLocalModelsConfig)({ managed: { port: outcome.port } });
  await deps.onChatPortMoved?.(`http://127.0.0.1:${outcome.port}`);
  return { port: outcome.port, adoptedPid: null };
}

export interface EmbeddingClearance {
  /** Options to start with; `undefined` when nothing should be started. */
  options: EmbeddingDaemonStartOptions | undefined;
  adoptedPid: number | null;
}

/**
 * The same for the embedding daemon. Its URL is read once at bootstrap,
 * so a moved embedding port reaches recall from the next launch on; the
 * start itself uses the new port now.
 */
export async function clearEmbeddingPort(
  cfg: Config,
  requested: EmbeddingDaemonStartOptions | undefined,
  chatPort: number,
  deps: PortClearanceDeps,
): Promise<EmbeddingClearance> {
  if (!requested) return { options: undefined, adoptedPid: null };
  const outcome = await (deps.reclaim ?? reclaimManagedPort)({
    port: requested.port,
    role: "embedding",
    ownDataDir: cfg.paths.localModelsDataDir,
    alias: requested.modelId,
    avoidPorts: [chatPort],
  });
  const line = describeReclaim(outcome, "embedding server", requested.port);
  if (line) deps.say(line);
  if (outcome.kind === "adopted") return { options: undefined, adoptedPid: outcome.pid };
  if (outcome.kind !== "moved") return { options: requested, adoptedPid: null };
  (deps.persist ?? persistUserLocalModelsConfig)({ embeddings: { port: outcome.port } });
  return { options: { ...requested, port: outcome.port }, adoptedPid: null };
}
