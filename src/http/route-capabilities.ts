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
        // Live gate state, not the boot-time config snapshot: reflects
        // `--no-approval` and later `setApprovalRequired` calls (the
        // Privacy-tab toggle), so admin UIs render the truth.
        approvalRequired: runtime.isApprovalRequired(),
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
