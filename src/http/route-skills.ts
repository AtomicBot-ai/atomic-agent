import { join } from "node:path";

import {
  installSkill,
  SkillInstallError,
  SkillNotFoundError,
  uninstallSkill,
} from "../skills/index.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

interface InstallBody {
  sourcePath?: string;
  force?: boolean;
  source?: "global" | "project";
}

interface UninstallBody {
  name?: string;
  source?: "global" | "project";
}

/**
 * `GET /api/skills` — list installed skills with their source (global
 * vs project-local). Mirrors the catalog used by the prompt prefix so
 * an admin surface shows exactly what the model will see.
 */
export function createListSkillsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const { runtime } = ctx;
    const records = runtime.skillRegistry.list();
    sendJson(res, 200, {
      skills: records.map((r) => ({
        name: r.manifest.name,
        description: r.manifest.description,
        version: r.manifest.version,
        source: r.source,
        rootDir: r.rootDir,
        dangerous: r.manifest.dangerous,
        requiresTools: r.manifest.requiresTools,
        requiresScripts: r.manifest.requiresScripts,
      })),
      errors: runtime.skillRegistry.errors(),
    });
  };
}

/**
 * `GET /api/skills/{name}` — return the full manifest plus the raw
 * SKILL.md body for the named skill. The body is needed by UIs that
 * want to render the full playbook without asking the agent to call
 * `skill.view`.
 */
export function createGetSkillHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const name = ctx.params.name;
    if (!name) {
      sendError(res, 400, openaiError("skill name is required"));
      return;
    }
    try {
      const record = ctx.runtime.skillRegistry.get(name);
      const body = await ctx.runtime.skillRegistry.readBody(name);
      sendJson(res, 200, {
        manifest: record.manifest,
        rootDir: record.rootDir,
        source: record.source,
        body,
      });
    } catch (err) {
      if (err instanceof SkillNotFoundError) {
        sendError(res, 404, openaiError(err.message, "invalid_request_error"));
        return;
      }
      throw err;
    }
  };
}

/**
 * `POST /api/skills/install` — install a skill from a local directory.
 * We do not support remote sources (see architecture doc §9). The
 * default target is the user-global skills dir; the request may pick
 * the project-local dir explicitly.
 */
export function createInstallSkillHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: InstallBody;
    try {
      body = await readJsonBody<InstallBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!body.sourcePath || typeof body.sourcePath !== "string") {
      sendError(res, 400, openaiError("sourcePath is required"));
      return;
    }
    const targetRoot = resolveSkillsTarget(ctx, body.source ?? "global");
    try {
      const result = await installSkill({
        sourceDir: body.sourcePath,
        targetRoot,
        ...(body.force ? { force: true } : {}),
      });
      await ctx.runtime.refreshSkills();
      sendJson(res, 200, {
        installed: true,
        manifest: result.manifest,
        installedAt: result.installedAt,
      });
    } catch (err) {
      if (err instanceof SkillInstallError) {
        sendError(
          res,
          err.code === "already_installed" ? 409 : 400,
          openaiError(err.message, "invalid_request_error", null, err.code),
        );
        return;
      }
      throw err;
    }
  };
}

/**
 * `POST /api/skills/uninstall` — remove an installed skill from the
 * selected root. Silently succeeds when the skill is not present so
 * the caller can use this to ensure a clean slate.
 */
export function createUninstallSkillHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: UninstallBody;
    try {
      body = await readJsonBody<UninstallBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!body.name || typeof body.name !== "string") {
      sendError(res, 400, openaiError("name is required"));
      return;
    }
    const targetRoot = resolveSkillsTarget(ctx, body.source ?? "global");
    const outcome = await uninstallSkill(targetRoot, body.name);
    await ctx.runtime.refreshSkills();
    sendJson(res, 200, {
      removed: outcome.removed,
      path: outcome.path,
    });
  };
}

function resolveSkillsTarget(
  ctx: { runtime: { config: { paths: { globalSkillsDir: string; projectSkillsDirName: string } }; capabilities: { workingDir: string } } },
  source: "global" | "project",
): string {
  if (source === "project") {
    return join(
      ctx.runtime.capabilities.workingDir,
      ctx.runtime.config.paths.projectSkillsDirName,
    );
  }
  return ctx.runtime.config.paths.globalSkillsDir;
}
