import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";
import { buildStablePrefix } from "../prompt/stable-prefix.js";
import type { ModelProfile } from "../llm/model-profile.js";
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
}

export interface ReplayStepReport {
  turnIndex: number;
  stepIndex: number;
  recordedHash: string;
  currentHash: string;
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
  const currentStablePrefix = buildStablePrefix({
    toolDescriptors: context.toolDescriptors,
    capabilities: context.capabilities,
    skillCatalog: context.skillCatalog,
    reasoningSystemToken: context.profile.reasoningSystemToken,
    ...(context.systemPersona !== undefined
      ? { systemPersona: context.systemPersona }
      : {}),
  });
  const currentHash = hashPrefix(currentStablePrefix);

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
    steps.push({
      turnIndex: recorded.turnIndex,
      stepIndex: recorded.stepIndex,
      recordedHash: recorded.stablePrefixHash,
      currentHash,
      drift: recorded.stablePrefixHash !== currentHash,
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
