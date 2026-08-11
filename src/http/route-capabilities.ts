import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/capabilities` — summary of the host environment and
 * runtime wiring. Consumers (admin UIs, status dashboards) use this to
 * decide which feature toggles to render without probing the agent
 * loop directly.
 */
export function createCapabilitiesHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const { runtime } = ctx;
    sendJson(res, 200, {
      runtime: "atomic-agent",
      capabilities: runtime.capabilities,
      paths: {
        stateDir: runtime.config.paths.stateDir,
        globalSkillsDir: runtime.config.paths.globalSkillsDir,
        projectSkillsDirName: runtime.config.paths.projectSkillsDirName,
        sessionsDbFile: runtime.config.paths.sessionsDbFile,
        grammarsDir: runtime.config.paths.grammarsDir,
        userConfigFile: runtime.config.paths.userConfigFile,
      },
      llama: {
        url: runtime.config.localModels.url,
        healthPath: runtime.config.localModels.healthPath,
        completionPath: runtime.config.localModels.completionPath,
      },
      browser: {
        channel: runtime.config.browser.channel,
        headless: runtime.config.browser.headless,
        cdpUrl: runtime.config.browser.cdpUrl,
      },
      agent: {
        tokenBudget: runtime.config.agent.tokenBudget,
        maxSteps: runtime.config.agent.maxSteps,
        toolTimeoutMs: runtime.config.agent.toolTimeoutMs,
        // Source of truth. Live gate state, not the boot-time config
        // snapshot: reflects `--no-approval` boots and later
        // `setApprovalLevel` calls (the Privacy-tab ladder), so admin UIs
        // render the truth. Level-aware clients read this and ignore
        // `approvalRequired`.
        approvalLevel: runtime.getApprovalLevel(),
        // DEPRECATED — approximate back-compat for clients written
        // against the binary approve-everything toggle this route shipped
        // with. `true` while any category can still prompt (level < 5),
        // derived from `approvalLevel` so the two cannot drift. Kept only
        // for wire compatibility; read `approvalLevel` instead.
        //
        // It is coarse at every mid-ladder level, not just one: a binary
        // client reads `approvalRequired: true` and may render "approvals
        // are on" while whole categories are already silent — file writes
        // at level 2 (workspace) / 3 (home), plus shell / script /
        // proc-kill at level 4 (operator). The boolean cannot express
        // "on for some categories, off for others"; only `approvalLevel`
        // carries that, which is why this field is deprecated.
        approvalRequired: runtime.getApprovalLevel() < 5,
      },
      tools: runtime.toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        readonly: t.readonly,
      })),
      skills: runtime.skillCatalog.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
      })),
    });
  };
}
