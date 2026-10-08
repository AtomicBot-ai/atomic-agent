import { randomUUID } from "node:crypto";
import type { AtomicAgentConfig } from "../../config/index.js";
import { createEmptySessionState, recordTurn, userTurn, type SessionState } from "../../session/index.js";
import type { SessionStore } from "../../session/session-store.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import type { BuildPromptInput, BuiltPrompt } from "../../prompt/build-prompt-types.js";
import { formatCurrentDate } from "../../prompt/current-date.js";
import type { CapabilitiesSummary, SkillCatalogEntry, ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import { SessionNotFoundError } from "../session-not-found-error.js";
import type { ResolvedModelMode } from "../../llm/model-mode.js";

export interface RuntimePromptPreviewDependencies {
  workingDir: string;
  sessionStore: Pick<SessionStore, "load">;
  profileStore: Pick<ProfileStore, "listForPrompt">;
  capabilities: CapabilitiesSummary;
  effectiveToolDescriptors(): readonly ToolDescriptor[];
  getSkillCatalog(): readonly SkillCatalogEntry[];
  getLiveProfile(): ModelProfile;
  resolveToolTransport(sessionId?: string): ToolCallTransport;
  resolveCatalogContextWindow(sessionId?: string): number | null;
  profileWindowApplies?(sessionId?: string): boolean;
  resolveModelMode?(sessionId?: string): ResolvedModelMode;
  resolveToolSchemaTokens?(sessionId: string, descriptors: readonly ToolDescriptor[]): number;
}

/** Build the next prompt without running memory prefetch, inference or persistence. */
export function createRuntimePromptPreview(config: AtomicAgentConfig, deps: RuntimePromptPreviewDependencies) {
  const { workingDir, sessionStore } = deps;
  return (input: {
    sessionId: string | null;
    userMessage?: string;
  }): BuiltPrompt => {
    let session: SessionState;
    if (input.sessionId) {
      const loaded = sessionStore.load(input.sessionId);
      if (!loaded) throw new SessionNotFoundError(input.sessionId);
      session = loaded;
    } else {
      // createEmptySessionState, not createSession: the latter saves.
      session = createEmptySessionState({
        id: `preview-${randomUUID()}`,
        workingDir,
      });
    }
    // The draft belongs in the transcript, exactly as the loop puts it
    // there (agent-loop.ts: `state = recordTurn(state, userTurn(text))`
    // before the first step). `buildPrompt`'s own `userMessage` input
    // never reaches the conversation section — it only feeds the profile
    // keyword gate and the task policy — so without this the preview
    // would price the draft at zero. Nothing is persisted: `session` is
    // an in-memory value here and `sessionStore.save` is never called.
    if (input.userMessage !== undefined && input.userMessage.length > 0) {
      session = recordTurn(session, userTurn(input.userMessage));
    }
    return buildPrompt(buildRuntimePromptInput(config, deps, session, input.userMessage));
  };

}

export function buildRuntimePromptInput(config: AtomicAgentConfig, deps: RuntimePromptPreviewDependencies, session: SessionState, userMessage?: string): BuildPromptInput {
    const transport = deps.resolveToolTransport(session.id);
    const modelMode = deps.resolveModelMode?.(session.id);
    const descriptors = deps.effectiveToolDescriptors();
    return {
      session,
      ...(modelMode ? { modelMode } : {}),
      ...(modelMode?.mode === "cloud" && transport === "native_tools" && deps.resolveToolSchemaTokens
        ? { toolSchemaTokens: deps.resolveToolSchemaTokens(session.id, descriptors) } : {}),
      // Called, not read: main made the descriptors late-bound so a live MCP
      // add/remove is visible without a restart. The preview wants the same
      // catalogue the next real turn would get.
      toolDescriptors: descriptors,
      capabilities: deps.capabilities,
      skillCatalog: deps.getSkillCatalog(),
      currentDate: formatCurrentDate(new Date()),
      profile: deps.getLiveProfile(),
      toolTransport: transport,
      suppressReasoningPrefill: transport === "native_tools",
      contextWindow: deps.resolveCatalogContextWindow(session.id),
      ...(deps.profileWindowApplies ? { profileWindowApplies: deps.profileWindowApplies(session.id) } : {}),
      ...(config.memory.profile.enabled
        ? { profileFacts: deps.profileStore.listForPrompt() }
        : {}),
      ...(userMessage !== undefined
        ? { userMessage }
        : {}),
    };
}
