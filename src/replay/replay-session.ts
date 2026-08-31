import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { buildStablePrefix } from "../prompt/stable-prefix.js";
import type { ModelProfile } from "../llm/model-profile.js";
import type { ToolCallTransport } from "../llm/provider/completion-types.js";
import { hashPrefix } from "../llm/slot-manager.js";

import type { TraceEvent } from "../tracing/index.js";
import { iterateTraceFile } from "../cli/trace-file-io.js";

export interface ReplayContext {
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  profile: ModelProfile;
  /**
   * Optional persona override. Defaults to the built-in persona inside
   * `buildStablePrefix`. Supply only when replaying traces produced by a
   * version that used a custom persona.
   */
  systemPersona?: string;
  /**
   * Transport the traced session used for tool calls. Since issue #285
   * the stable prefix differs by construction between `"grammar"` and
   * `"native_tools"`, so drift detection must compare against the right
   * variant. Traces do not record the transport, so when this is omitted
   * the replay builds BOTH variants and a recorded hash counts as clean
   * when it matches EITHER — otherwise every native-transport trace
   * (the default on openai / subscription-cli providers) would report
   * 100% false drift. Supply the transport to pin the comparison to one
   * variant when it is known.
   */
  toolTransport?: ToolCallTransport;
}

export interface ReplayStepReport {
  turnIndex: number;
  stepIndex: number;
  recordedHash: string;
  /**
   * Hash of the matched prefix variant; when nothing matched (drift),
   * the hash of the pinned transport's variant, or of the `"grammar"`
   * variant when no transport was pinned.
   */
  currentHash: string;
  /** Transport whose current prefix matched `recordedHash`; `null` on drift. */
  matchedTransport: ToolCallTransport | null;
  drift: boolean;
  tokens: {
    recordedStablePrefix: number;
    recordedTotal: number;
  };
}

export interface ReplayReport {
  sessionId: string;
  workingDir: string | null;
  totalSteps: number;
  driftCount: number;
  steps: ReplayStepReport[];
}

/**
 * Drift-detection replay: walks the session NDJSON, pulls every
 * `prompt_captured` event, rebuilds the stable prefix with the
 * current `ReplayContext`, and compares the salted hash to the one
 * recorded at runtime. Mismatches surface as `drift: true` entries —
 * typically caused by a persona / tool-descriptor / skill-catalog change
 * between recording and replay.
 *
 * Replay does NOT reproduce LLM non-determinism or external world state
 * (browser / FS); it is a prompt-drift postmortem, not a full simulator.
 */
export async function replaySession(options: {
  path: string;
  context: ReplayContext;
}): Promise<ReplayReport> {
  const { path, context } = options;
  const prefixFor = (transport: ToolCallTransport): string =>
    buildStablePrefix({
      toolDescriptors: context.toolDescriptors,
      capabilities: context.capabilities,
      skillCatalog: context.skillCatalog,
      reasoningSystemToken: context.profile.reasoningSystemToken,
      toolTransport: transport,
      ...(context.systemPersona !== undefined
        ? { systemPersona: context.systemPersona }
        : {}),
    });
  // Candidate order matters only for the no-match `currentHash` fallback:
  // the first entry (pinned transport, else `"grammar"`) supplies it.
  const transports: readonly ToolCallTransport[] =
    context.toolTransport !== undefined
      ? [context.toolTransport]
      : ["grammar", "native_tools"];
  const candidates = transports.map((transport) => ({
    transport,
    hash: hashPrefix(prefixFor(transport)),
  }));

  let sessionId = "";
  let workingDir: string | null = null;
  const steps: ReplayStepReport[] = [];

  for await (const event of iterateTraceFile(path)) {
    if (event.type === "session_started") {
      sessionId = event.sessionId;
      workingDir = event.workingDir;
      continue;
    }
    if (event.type !== "prompt_captured") continue;
    const recorded = event as Extract<TraceEvent, { type: "prompt_captured" }>;
    const matched =
      candidates.find((c) => c.hash === recorded.stablePrefixHash) ?? null;
    steps.push({
      turnIndex: recorded.turnIndex,
      stepIndex: recorded.stepIndex,
      recordedHash: recorded.stablePrefixHash,
      currentHash: matched !== null ? matched.hash : candidates[0]!.hash,
      matchedTransport: matched !== null ? matched.transport : null,
      drift: matched === null,
      tokens: {
        recordedStablePrefix: recorded.tokens.stablePrefix,
        recordedTotal: recorded.tokens.total,
      },
    });
  }

  return {
    sessionId,
    workingDir,
    totalSteps: steps.length,
    driftCount: steps.filter((s) => s.drift).length,
    steps,
  };
}
