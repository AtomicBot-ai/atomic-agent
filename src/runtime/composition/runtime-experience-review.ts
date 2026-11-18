import type { AtomicAgentConfig } from "../../config/index.js";
import type { RunTurnResult } from "../../agent/agent-contract.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { buildCloudSubcallRequest } from "../../llm/provider/cloud-subcall.js";
import type { CompletionRequest, ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import { isIncognitoSession, type SessionState } from "../../session/index.js";
import { SkillChangeRecorder, skillCuratorPaths } from "../../skills/curator/index.js";
import {
  collectTurnExperience,
  EXPERIENCE_REVIEW_LIMITS,
  EXPERIENCE_REVIEW_SCHEMA,
  EXPERIENCE_REVIEW_SYSTEM,
  patchableSkillNames,
  readPatchCandidates,
  runExperienceReview,
  shouldReviewTurn,
  takenSkillNames,
  type TurnExperience,
} from "../../skills/learning/index.js";
import { DEFAULT_SKILLS_SELF_LEARNING } from "../../config/skills-config.js";
import { listStarterSkillNames } from "../../skills/seed-starter-skills.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { SKILL_EDIT_TOOLS, skillTargets } from "../../tools/skill/skill-edit-tracker.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { TurnOrigin } from "../turn-controller.js";

/**
 * Self-learning after a long turn (ATO-67), wired like the next-step
 * suggestion: fired as a bare `void` after the turn is saved, its own
 * deadline, its abort handle in the shared teardown set. One review runs
 * at a time; a turn that ends while one is in flight is not reviewed
 * (OpenClaw runs reviews one by one too). The decision and the write
 * live in `skills/learning/experience-review.ts`.
 */
export interface ExperienceReviewerDeps {
  getConfig: () => AtomicAgentConfig;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  slotManager: Pick<SlotManager, "sideCallSlotId">;
  resolveTransport: () => ToolCallTransport;
  skillRegistry: Pick<SkillRegistry, "listAll">;
  /** Re-read the skills folder after a write, so the next turn sees the skill. */
  refreshSkills: () => Promise<void>;
  /** Teardown's handles (`pendingSessionNamings`, shared with naming). */
  pending: Set<AbortController>;
  isShutdown: () => boolean;
  logger: StructuredLogger;
  /** Test seam; the release list by default. */
  starterNames?: () => Promise<ReadonlySet<string>>;
}

/** Turns nobody reviews: a scheduled task, a fusion worker, a hook (OpenClaw skips cron, subagent and hook runs). */
const UNREVIEWED_ORIGINS: ReadonlySet<TurnOrigin> = new Set(["scheduler", "fusion"]);

/** Fallback-chain partition for the call, like `title:` and `next-step:`. */
export const EXPERIENCE_REVIEW_SESSION_PREFIX = "learn:";

export interface ReviewTurnInfo {
  result: Pick<RunTurnResult, "reason" | "stepCount" | "stopCause">;
  origin: TurnOrigin | undefined;
  /** A `skill eval` run: it must not change skills either. */
  memoryReadOnly?: boolean;
}

function selfLearning(config: AtomicAgentConfig) {
  return config.skills.selfLearning ?? DEFAULT_SKILLS_SELF_LEARNING;
}

function editedSkills(experience: TurnExperience, workingDir: string, skillsDir: string): boolean {
  const tools: ReadonlySet<string> = new Set(SKILL_EDIT_TOOLS);
  return experience.steps.some((s) => tools.has(s.tool) && skillTargets(s.tool, s.args, workingDir, skillsDir).length > 0);
}

/** The model's answer: the emit tool's arguments on a cloud link, the text otherwise. */
function answerText(result: Pick<CompletionResult, "content" | "toolCalls">): string {
  const args = result.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) return args;
  return result.content ?? "";
}

export function createExperienceReviewer(deps: ExperienceReviewerDeps) {
  let running: Promise<void> | null = null;

  const review = async (state: SessionState, experience: TurnExperience): Promise<void> => {
    if (deps.isShutdown()) return;
    const config = deps.getConfig();
    const skillsDir = config.paths.globalSkillsDir;
    const paths = skillCuratorPaths(config.paths.stateDir);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), EXPERIENCE_REVIEW_LIMITS.timeoutMs);
    timer.unref?.();
    deps.pending.add(abort);
    try {
      const targets = {
        records: deps.skillRegistry.listAll().map((e) => e.record),
        starterNames: await (deps.starterNames ?? listStarterSkillNames)(),
        globalSkillsDir: skillsDir,
        archiveDir: paths.archiveDir,
      };
      const candidates = await readPatchCandidates(skillsDir, await patchableSkillNames(experience.usedSkills, targets));
      const takenNames = await takenSkillNames(targets);
      const sessionId = `${EXPERIENCE_REVIEW_SESSION_PREFIX}${state.id}`;
      const transport = deps.resolveTransport();
      const result = await runExperienceReview({
        experience,
        candidates,
        takenNames,
        ask: async (prompt) => {
          const request: CompletionRequest & { grammar: string; slotId: number; sessionId: string } =
            transport === "native_tools"
              ? {
                  ...buildCloudSubcallRequest({
                    prompt,
                    emitFunctionName: "emit_skill_review",
                    argsSchema: EXPERIENCE_REVIEW_SCHEMA,
                    description: "Emit the review decision: none, create or patch",
                    sessionId,
                    maxTokens: EXPERIENCE_REVIEW_LIMITS.maxTokens,
                  }),
                  sessionId,
                  grammar: "",
                  slotId: -1,
                }
              : {
                  prompt,
                  sessionId,
                  grammar: "",
                  maxTokens: EXPERIENCE_REVIEW_LIMITS.maxTokens,
                  slotId: deps.slotManager.sideCallSlotId(),
                  ...(config.localModels.useServerTemplate === "off"
                    ? {}
                    : {
                        chat: {
                          system: EXPERIENCE_REVIEW_SYSTEM,
                          user: prompt,
                          prefixHash: "experience-review",
                          enableThinking: false,
                        },
                      }),
                };
          const completion = await deps.llmComplete({ ...request, signal: abort.signal });
          return answerText(completion);
        },
        apply: {
          skillsDir,
          recorder: new SkillChangeRecorder(skillsDir, paths),
          sessionId: state.id,
        },
      });
      if (deps.isShutdown()) return;
      if (result.applied) {
        deps.logger.info("self-learning: saved a skill", {
          sessionId: state.id,
          id: result.change.id,
          skill: result.change.name,
          action: result.change.action,
          reason: result.change.reason,
        });
        await deps.refreshSkills();
      } else {
        deps.logger.debug("self-learning: nothing saved", {
          sessionId: state.id,
          reason: result.reason,
          ...("issues" in result && result.issues ? { issues: result.issues } : {}),
        });
      }
    } catch (err) {
      deps.logger.warn("self-learning review failed; skills were left as they were", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
      deps.pending.delete(abort);
    }
  };

  /**
   * Fire a review for a finished turn when the setting, the origin, the
   * turn's length and its ending all allow it. Never awaits the call and
   * never throws: the caller has already saved and is about to return.
   */
  const maybeReview = (state: SessionState, info: ReviewTurnInfo): boolean => {
    try {
      if (running || deps.isShutdown()) return false;
      if (info.origin !== undefined && UNREVIEWED_ORIGINS.has(info.origin)) return false;
      if (info.memoryReadOnly === true || isIncognitoSession(state)) return false;
      if (info.result.reason !== "reply" && info.result.reason !== "finish") return false;
      // A ceiling ended the turn: its reply is a summary of unfinished work,
      // and a budget stop must not buy one more paid call.
      if (info.result.stopCause !== undefined) return false;
      const config = deps.getConfig();
      const { enabled, minSteps } = selfLearning(config);
      const experience = enabled && info.result.stepCount >= minSteps ? collectTurnExperience(state.turns) : null;
      const verdict = shouldReviewTurn({
        enabled,
        stepCount: info.result.stepCount,
        minSteps,
        experience,
        turnEditedSkills: experience !== null && editedSkills(experience, state.workingDir, config.paths.globalSkillsDir),
      });
      if (!verdict.review) return false;
      running = review(state, verdict.experience)
        .catch((err: unknown) => {
          deps.logger.warn("self-learning review failed", { sessionId: state.id, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          running = null;
        });
      return true;
    } catch (err) {
      deps.logger.warn("self-learning review skipped", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  /** Settles when no review is in flight (tests, an orderly shutdown). */
  const whenIdle = (): Promise<void> => running ?? Promise.resolve();

  return { maybeReview, whenIdle };
}
