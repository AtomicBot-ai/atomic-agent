/**
 * ATO-2172: `atag launch [claude|codex|opencode] [--agent] [--model <id>] [--print-env] [-- args]`.
 *
 * Starts another coding CLI on this machine's model, the way `ollama
 * launch claude` points Claude Code at Ollama: find the binary on PATH,
 * reuse or start a serve (launch-serve.ts), build the CLI's env and args
 * (launch-plan.ts), run it with the terminal attached and exit with its
 * exit code. Nothing is written to the CLI's own config files.
 *
 * ATO-2451: the CLI never gets the serve key (admin). Each run gets its
 * own `member` token (launch-token.ts), removed when the CLI exits;
 * `--print-env`, `--print-key` and `--config` use one lasting `member`
 * token. The serve key itself is only used to find out whether serve is
 * up, and as the fallback when the token store cannot be written.
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
import { LAUNCH_HELP, parseLaunchArgs, type LaunchArgs } from "./launch-args.js";
import { runChild } from "./launch-child.js";
import type { LaunchConfigFs } from "./launch-config.js";
import { runLaunchConfig } from "./launch-config-command.js";
import type { LaunchIntegration } from "./launch-integrations.js";
import { findLaunchBinary, offerInstall } from "./launch-install.js";
import { localModelProbeMessage, probeLocalModel, type LocalModelProbe } from "./launch-local-model.js";
import { buildPlan, formatPrintEnv, LOCAL_MODEL_FALLBACK_NAME } from "./launch-plan.js";
import { launchChoices, pickLaunchIntegration } from "./launch-picker.js";
import { issueRunToken, lastingToken, type IssuedToken } from "./launch-token.js";
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
export { buildPlan, formatPrintEnv, LOCAL_MODEL_FALLBACK_NAME, MASKED } from "./launch-plan.js";

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
  /** ATO-2448: `--config` / `--revert` file access and paths; tests pass their own. */
  readonly configFs?: LaunchConfigFs;
  readonly home?: string;
  readonly keyCommand?: string;
  /** ATO-2451: the per-run token (launch-token.ts); tests pass their own. */
  readonly issueToken?: (stateDir: string, cliId: string) => IssuedToken;
  readonly lastingToken?: (stateDir: string) => { readonly token: string } | { readonly error: string };
}

/** The operator's own key from the environment, as serve takes it. */
function givenKey(env: NodeJS.ProcessEnv): string | null {
  return env.ATOMIC_AGENT_API_KEY?.trim() ? env.ATOMIC_AGENT_API_KEY.trim() : null;
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
  if (parsed.printKey) {
    // Claude Code's apiKeyHelper (ATO-2448): the lasting member token
    // alone on stdout, never the admin serve key (ATO-2451).
    const found = (deps.lastingToken ?? lastingToken)((deps.stateDir ?? resolveStateDir)());
    if ("error" in found) {
      writeErr("launch: could not save the launch key in the Atomic Agent folder; see atag http tokens list.\n");
      return 1;
    }
    write(`${found.token}\n`);
    return 0;
  }
  const findBinary = deps.findBinary ?? ((b: string) => findLaunchBinary(b, env));
  let integration = parsed.integration;
  if (integration === null) {
    const picked = await pickLaunchIntegration(launchChoices(findBinary), { write, writeErr, isTTY: deps.isTTY, ask: deps.ask });
    if (picked.kind === "done") return picked.code;
    integration = picked.integration;
  }
  let binaryPath = findBinary(integration.binary);
  if (!binaryPath && !parsed.printEnv && !parsed.config && !parsed.revert) {
    // ATO-2450: in a terminal, offer to install it (shows the command, asks first).
    const installed = await offerInstall(integration, {
      isTTY: deps.isTTY,
      ask: deps.ask,
      findBinary,
      spawn: deps.spawn ?? nodeSpawn,
      env,
      writeErr,
    });
    if ("code" in installed) return installed.code;
    binaryPath = installed.path;
  }

  const stateDir = (deps.stateDir ?? resolveStateDir)();
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const given = givenKey(env);
  const key = (deps.resolveKey ?? resolveServeApiKey)(given, stateDir);
  if ("error" in key) {
    writeErr(`launch: ${key.error}\n`);
    return 1;
  }

  const local = parsed.mode === "local";
  const probe = deps.probeLocal ?? ((b: string, t: string) => probeLocalModel(b, t));
  const findServe = deps.findServe ?? ((s: string, c: string | null) => findReusableServe(s, c, deps.serveDeps));
  if (parsed.config || parsed.revert) {
    return runLaunchConfig(integration, parsed, {
      stateDir,
      env,
      home: deps.home,
      fs: deps.configFs,
      keyCommand: deps.keyCommand,
      findServe,
      probeLocal: probe,
      cwd,
      key: key.key,
      lastingToken: deps.lastingToken,
      write,
      writeErr,
    });
  }
  // The agent behind /v1 runs its tools in the serve's folder; the bare model has none.
  let serve = await findServe(stateDir, local ? null : cwd);
  if (parsed.printEnv) {
    // Printing starts nothing: a serve started here would stop as soon as
    // this process exits.
    if (!serve) writeErr(`launch: no atag serve runs${local ? "" : ` in ${cwd}`}; start one with: atag serve --cwd .\n`);
    const serveUrl = serve?.baseUrl ?? loopbackBaseUrl(DEFAULT_SERVE_PORT);
    // ATO-2451: what is printed outlives this process, so it is the
    // lasting member token of --config, never the admin serve key.
    const lasting = (deps.lastingToken ?? lastingToken)(stateDir);
    if ("error" in lasting) {
      writeErr("launch: could not save the launch key in the Atomic Agent folder; see atag http tokens list.\n");
      return 1;
    }
    const found = local && serve ? await probe(serve.baseUrl, lasting.token) : null;
    const modelId = found?.ok ? found.modelId : null;
    write(formatPrintEnv(binaryPath ?? integration.binary, buildPlan(integration, parsed, serveUrl, lasting.token, modelId)));
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

  // ATO-2451: the CLI gets a `member` token of its own for this run, not
  // the admin serve key; it is removed when the CLI exits. If the token
  // store cannot be written, fall back to the serve key, with a warning.
  const issued = (deps.issueToken ?? issueRunToken)(stateDir, integration.id);
  let runKey = key.key;
  let revoke = (): void => {};
  if ("error" in issued) {
    writeErr(`launch: could not make a separate key for ${integration.displayName}; it gets the serve key this time.\n`);
  } else {
    runKey = issued.token;
    revoke = issued.revoke;
  }
  try {
    return await runWithKey(integration, parsed, serve, runKey, binaryPath as string, { ...deps, env, writeErr, probe });
  } finally {
    revoke();
  }
}

async function runWithKey(
  integration: LaunchIntegration,
  parsed: LaunchArgs,
  serve: LaunchServe,
  runKey: string,
  binaryPath: string,
  deps: LaunchCommandDeps & {
    readonly env: NodeJS.ProcessEnv;
    readonly writeErr: (s: string) => void;
    readonly probe: NonNullable<LaunchCommandDeps["probeLocal"]>;
  },
): Promise<number> {
  const { env, writeErr, probe } = deps;
  const local = parsed.mode === "local";
  let modelId: string | null = null;
  if (local) {
    const found = await probe(serve.baseUrl, runKey);
    if (!found.ok) {
      writeErr(localModelProbeMessage(found.reason, serve.port));
      return 1;
    }
    modelId = found.modelId;
  } else if (!(await (deps.checkKey ?? serveAcceptsKey)(serve.baseUrl, runKey))) {
    writeErr(localModelProbeMessage("auth", serve.port));
    return 1;
  }

  const plan = buildPlan(integration, parsed, serve.baseUrl, runKey, modelId);
  if (local) {
    const name = parsed.model ?? modelId ?? LOCAL_MODEL_FALLBACK_NAME;
    writeErr(`launch: ${integration.displayName} on the local model ${name}, through ${serve.baseUrl}/local\n`);
    writeErr(`launch: ${integration.displayName} runs its own tools here; for Atomic Agent's tools and memory use --agent\n`);
  } else {
    writeErr(`launch: ${integration.displayName} on Atomic Agent at ${serve.baseUrl}\n`);
    writeErr(launchApprovalNote(serve));
  }
  const spawn = deps.spawn ?? nodeSpawn;
  for (const step of plan.setup ?? []) {
    // ATO-2449: e.g. `cline auth ...`; its output is the CLI's own.
    const code = await runChild(binaryPath, { env: plan.env, args: step }, env, spawn, writeErr);
    if (code !== 0) {
      writeErr(`launch: ${integration.displayName} setup (${step[0] ?? ""}) failed with exit code ${code}; not starting it.\n`);
      return code;
    }
  }
  return runChild(binaryPath, plan, env, spawn, writeErr);
}
