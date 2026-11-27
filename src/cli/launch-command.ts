/**
 * ATO-2172: `atag launch [claude|codex|opencode] [--agent] [--model <id>] [--print-env] [-- args]`.
 *
 * Starts another coding CLI on this machine's model, the way `ollama
 * launch claude` points Claude Code at Ollama: find the binary on PATH,
 * reuse or start a serve (launch-serve.ts), take the serve API key the
 * same way serve does (`ATOMIC_AGENT_API_KEY`, else
 * `<stateDir>/serve-api.key`), build the CLI's env and args
 * (launch-integrations.ts), run it with the terminal attached and exit
 * with its exit code. Nothing is written to the CLI's own config files.
 *
 * ATO-2447: by default the CLI gets the bare local model through serve's
 * `/local/v1` routes and runs its own tools; `--agent` keeps the first
 * slice, an Atomic Agent turn behind `/v1`.
 *
 * The key is never printed: `--print-env` shows every variable but the
 * secret ones, which it masks.
 */

import { spawn as nodeSpawn } from "node:child_process";

import { resolveStateDir } from "../config/index.js";
import { findOnPath } from "./cloudflared.js";
import { LAUNCH_HELP, parseLaunchArgs, type LaunchArgs } from "./launch-args.js";
import { runChild } from "./launch-child.js";
import { DEFAULT_LAUNCH_MODEL, type LaunchIntegration, type LaunchPlan } from "./launch-integrations.js";
import { localModelProbeMessage, probeLocalModel, type LocalModelProbe } from "./launch-local-model.js";
import { launchChoices, pickLaunchIntegration } from "./launch-picker.js";
import {
  DEFAULT_SERVE_PORT,
  findReusableServe,
  loopbackBaseUrl,
  serveAcceptsKey,
  startLaunchServe,
  type LaunchServe,
  type LaunchServeDeps,
} from "./launch-serve.js";
import { resolveServeApiKey } from "./serve-api-key.js";

export { LAUNCH_HELP, parseLaunchArgs, type LaunchArgs } from "./launch-args.js";
export { runChild } from "./launch-child.js";

export const MASKED = "<hidden: atag serve --print-api-key>";

/** Model label for the bare local model when the server names none. */
export const LOCAL_MODEL_FALLBACK_NAME = "local-model";

/**
 * Where approvals go (ATO-2172 review): the launched CLI never shows
 * one. A serve started here refuses them at once; a reused one asks in
 * its /panel page. Only the `--agent` mode has approvals at all.
 */
export function launchApprovalNote(serve: { baseUrl: string; started: boolean }): string {
  // ATO-2737: the real address, not a `<port>` placeholder. A serve the
  // person starts themselves listens on the default port.
  return serve.started
    ? `launch: approvals are refused on this serve (the CLI cannot show them); what needs one comes back as text. To approve instead, run \`atag serve --cwd .\` in another terminal and open ${loopbackBaseUrl(DEFAULT_SERVE_PORT)}/panel\n`
    : `launch: approval prompts from this serve wait in ${serve.baseUrl}/panel (or the desktop app)\n`;
}

/** Shell-style lines for `--print-env`, secrets masked. */
export function formatPrintEnv(binary: string, plan: LaunchPlan): string {
  const quote = (v: string): string => (/^[\w@%+=:,./-]*$/.test(v) && v !== "" ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  const lines = Object.entries(plan.env).map(([name, value]) =>
    plan.secretEnv.includes(name) ? `export ${name}=${quote(MASKED)}` : `export ${name}=${quote(value)}`,
  );
  lines.push([binary, ...plan.args].map(quote).join(" "));
  return `${lines.join("\n")}\n`;
}

export interface LaunchCommandDeps {
  readonly write?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly stateDir?: () => string;
  readonly cwd?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly findBinary?: (binary: string) => string | null;
  /** `cwd` null: a serve in any folder will do (the bare local model). */
  readonly findServe?: (stateDir: string, cwd: string | null) => Promise<LaunchServe | null>;
  readonly startServe?: (stateDir: string, cwd: string) => Promise<LaunchServe | { readonly error: string }>;
  readonly checkKey?: (baseUrl: string, token: string) => Promise<boolean>;
  /** ATO-2447: is the local model up behind this serve, and what is it called. */
  readonly probeLocal?: (baseUrl: string, token: string) => Promise<LocalModelProbe>;
  readonly resolveKey?: (given: string | null, stateDir: string) => { key: string } | { error: string };
  readonly spawn?: typeof nodeSpawn;
  readonly serveDeps?: LaunchServeDeps;
  /** ATO-2737: the picker of bare `atag launch`; defaults to stdin and stdout being a TTY. */
  readonly isTTY?: () => boolean;
  readonly ask?: (prompt: string) => Promise<string>;
}

export async function launchCommand(args: string[], deps: LaunchCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => void process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => void process.stderr.write(t));
  const parsed = parseLaunchArgs(args);
  if (parsed === "help") {
    write(`${LAUNCH_HELP}\n`);
    return 0;
  }
  if ("error" in parsed) {
    writeErr(`launch: ${parsed.error}\n\n${LAUNCH_HELP}\n`);
    return 2;
  }
  const env = deps.env ?? process.env;
  const findBinary = deps.findBinary ?? ((b: string) => findOnPath(b, env));
  let integration = parsed.integration;
  if (integration === null) {
    const picked = await pickLaunchIntegration(launchChoices(findBinary), { write, writeErr, isTTY: deps.isTTY, ask: deps.ask });
    if (picked.kind === "done") return picked.code;
    integration = picked.integration;
  }
  const binaryPath = findBinary(integration.binary);
  if (!binaryPath && !parsed.printEnv) {
    writeErr(
      `launch: ${integration.displayName} is not installed (no \`${integration.binary}\` on PATH).\n` +
        `Install it with: ${integration.installHint}\n`,
    );
    return 1;
  }

  const stateDir = (deps.stateDir ?? resolveStateDir)();
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const given = env.ATOMIC_AGENT_API_KEY?.trim() ? env.ATOMIC_AGENT_API_KEY.trim() : null;
  const key = (deps.resolveKey ?? resolveServeApiKey)(given, stateDir);
  if ("error" in key) {
    writeErr(`launch: ${key.error}\n`);
    return 1;
  }

  const local = parsed.mode === "local";
  const probe = deps.probeLocal ?? ((b: string, t: string) => probeLocalModel(b, t));
  const findServe = deps.findServe ?? ((s: string, c: string | null) => findReusableServe(s, c, deps.serveDeps));
  // The agent behind /v1 runs its tools in the serve's folder; the bare model has none.
  let serve = await findServe(stateDir, local ? null : cwd);
  if (parsed.printEnv) {
    // Printing starts nothing: a serve started here would stop as soon as
    // this process exits.
    if (!serve) writeErr(`launch: no atag serve runs${local ? "" : ` in ${cwd}`}; start one with: atag serve --cwd .\n`);
    const serveUrl = serve?.baseUrl ?? loopbackBaseUrl(DEFAULT_SERVE_PORT);
    const found = local && serve ? await probe(serve.baseUrl, key.key) : null;
    const modelId = found?.ok ? found.modelId : null;
    write(formatPrintEnv(binaryPath ?? integration.binary, buildPlan(integration, parsed, serveUrl, key.key, modelId)));
    return 0;
  }
  if (!serve) {
    writeErr(`launch: starting atag serve for ${cwd} ...\n`);
    const started = await (deps.startServe ?? ((s: string, c: string) => startLaunchServe(s, c, deps.serveDeps)))(stateDir, cwd);
    if ("error" in started) {
      writeErr(`launch: ${started.error}\n`);
      return 1;
    }
    serve = started;
  }

  let modelId: string | null = null;
  if (local) {
    const found = await probe(serve.baseUrl, key.key);
    if (!found.ok) {
      writeErr(localModelProbeMessage(found.reason, serve.port));
      return 1;
    }
    modelId = found.modelId;
  } else if (!(await (deps.checkKey ?? serveAcceptsKey)(serve.baseUrl, key.key))) {
    writeErr(localModelProbeMessage("auth", serve.port));
    return 1;
  }

  const plan = buildPlan(integration, parsed, serve.baseUrl, key.key, modelId);
  if (local) {
    const name = parsed.model ?? modelId ?? LOCAL_MODEL_FALLBACK_NAME;
    writeErr(`launch: ${integration.displayName} on the local model ${name}, through ${serve.baseUrl}/local\n`);
    writeErr(`launch: ${integration.displayName} runs its own tools here; for Atomic Agent's tools and memory use --agent\n`);
  } else {
    writeErr(`launch: ${integration.displayName} on Atomic Agent at ${serve.baseUrl}\n`);
    writeErr(launchApprovalNote(serve));
  }
  return runChild(binaryPath as string, plan, env, deps.spawn ?? nodeSpawn, writeErr);
}

/**
 * The CLI's env and args. Local mode points it at `<serve>/local` and
 * names the loaded model (the person's `--model` wins); agent mode at
 * the serve root with the `atomic-agent` label.
 */
export function buildPlan(
  integration: LaunchIntegration,
  parsed: Pick<LaunchArgs, "mode" | "model" | "extraArgs">,
  serveUrl: string,
  token: string,
  localModelId: string | null,
): LaunchPlan {
  if (parsed.mode === "agent") {
    return integration.build({
      baseUrl: serveUrl,
      token,
      model: parsed.model ?? DEFAULT_LAUNCH_MODEL,
      modelGiven: parsed.model !== null,
      extraArgs: parsed.extraArgs,
    });
  }
  return integration.build({
    baseUrl: `${serveUrl}/local`,
    token,
    model: parsed.model ?? localModelId ?? LOCAL_MODEL_FALLBACK_NAME,
    // Name the real model even without --model, so the CLI shows it and
    // does not ask the local server for a cloud model id.
    modelGiven: true,
    extraArgs: parsed.extraArgs,
  });
}
