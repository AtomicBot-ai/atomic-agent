import {
  installSkillFromPath,
  listSkills,
  uninstallSkillByName,
} from "../runtime-api/index.js";
import { SkillNotFoundError } from "../skills/index.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { sendRuntimeApiError } from "./runtime-api-http.js";

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
 * vs project-local) and enabled/disabled state via the shared facade.
 */
export function createListSkillsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const { skills, errors } = listSkills(ctx.runtime);
    sendJson(res, 200, {
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        source: s.source,
        rootDir: s.rootDir,
        dangerous: s.dangerous,
        requiresTools: s.requiresTools,
        requiresScripts: s.requiresScripts,
        disabled: s.disabled,
      })),
      errors,
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
    try {
      const result = await installSkillFromPath(ctx.runtime, {
        sourcePath: body.sourcePath ?? "",
        source: body.source ?? "global",
        ...(body.force ? { force: true } : {}),
      });
      sendJson(res, 200, {
        installed: true,
        manifest: result.manifest,
        installedAt: result.installedAt,
      });
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
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
    try {
      const outcome = await uninstallSkillByName(ctx.runtime, {
        name: body.name ?? "",
        source: body.source ?? "global",
      });
      sendJson(res, 200, { removed: outcome.removed, path: outcome.path });
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}
