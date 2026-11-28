import { defaultClaudeCommandsDir, listCommandCatalog, prepareCommand } from "../plugins/command-catalog.js";
import { CommandShellRefused } from "../plugins/command-shell.js";
import { createRegistryShellRunner } from "../plugins/command-shell-runner.js";
import type { UserCommandOptions } from "../plugins/user-commands.js";
import { createProjectCommandTrust } from "../skills/project-trust.js";
import { openaiError } from "./openai-errors.js";
import {
  onClientGone,
  readJsonBody,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

/**
 * Slash commands for a frontend's `/` menu (ATO-2441): the operator's own
 * commands and plugin commands, listed and rendered by the same code the
 * terminal uses (`plugins/command-catalog.ts`).
 *
 * `GET /api/commands?sessionId=<id>` lists them for the chat's folder (the
 * folder `serve` started in without one): `{ workingDir, commands,
 * hiddenProjectCommands, errors }`.
 *
 * `POST /api/commands/render` with `{ name, args?, sessionId? }` returns
 * `{ text, source, model? }`: the message to send as the person's own.
 * `@path` stays as written (the frontend inlines files as for a typed
 * message). Shell lines run here, one `os.shell.run` each, asking through
 * the normal approval stream (`GET /api/events`) in that chat, or as
 * `NEW_CHAT_SESSION_ID` before the chat has a session. A line that is not
 * allowed or fails answers `409` with `error.code: "command_refused"` and
 * nothing to send. A client that goes away stops the line that is running.
 */
export const NEW_CHAT_SESSION_ID = "slash-command-new-chat";

interface RenderBody {
  name?: unknown;
  args?: unknown;
  sessionId?: unknown;
}

function commandOptions(ctx: HandlerContext, sessionId: string | null): UserCommandOptions | { status: number; message: string } {
  let workingDir = ctx.runtime.capabilities.workingDir;
  if (sessionId) {
    const session = ctx.runtime.sessionStore.load(sessionId);
    if (!session) return { status: 404, message: "session not found" };
    workingDir = session.workingDir;
  }
  const { paths, skills } = ctx.runtime.config;
  return { stateDir: paths.stateDir, workingDir, claudeCommandsDir: defaultClaudeCommandsDir(),
    isProjectCommandTrusted: createProjectCommandTrust(paths.userConfigFile, skills.projectTrust, workingDir) };
}

export function createListCommandsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId");
    const options = commandOptions(ctx, sessionId);
    if ("status" in options) { sendError(res, options.status, openaiError(options.message)); return; }
    const catalog = listCommandCatalog(options);
    sendJson(res, 200, { workingDir: options.workingDir, commands: catalog.rows,
      hiddenProjectCommands: catalog.hiddenProjectCommands, errors: catalog.diagnostics });
  };
}

export function createRenderCommandHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: RenderBody;
    try {
      body = await readJsonBody<RenderBody>(req);
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (typeof body.name !== "string" || !body.name.trim()) { sendError(res, 400, openaiError("name is required", "invalid_request_error", "name")); return; }
    if (body.args !== undefined && typeof body.args !== "string") { sendError(res, 400, openaiError("args must be a string", "invalid_request_error", "args")); return; }
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
    const options = commandOptions(ctx, sessionId);
    if ("status" in options) { sendError(res, options.status, openaiError(options.message)); return; }
    const controller = new AbortController();
    onClientGone(res, () => controller.abort());
    const runShell = createRegistryShellRunner({ registry: ctx.runtime.toolRegistry, sessionId: sessionId ?? NEW_CHAT_SESSION_ID,
      workingDir: options.workingDir, signal: controller.signal });
    try {
      const prepared = await prepareCommand(options, body.name.trim().replace(/^\//, ""), body.args ?? "", { runShell });
      sendJson(res, 200, prepared);
    } catch (err) {
      if (err instanceof CommandShellRefused) {
        sendError(res, 409, openaiError(err.message, "invalid_request_error", null, "command_refused"));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, /not available/.test(message) ? 404 : 400, openaiError(message));
    }
  };
}
