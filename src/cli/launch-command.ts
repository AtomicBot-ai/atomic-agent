/**
 * ATO-2172: `atag launch [claude|codex|opencode] [--model <id>] [--print-env] [-- args]`.
 *
 * Starts another coding CLI pointed at this machine's `atag serve`, the way
 * `ollama launch claude` points Claude Code at Ollama: find the binary on
 * PATH, reuse or start a serve (launch-serve.ts), take the serve API key
 * the same way serve does (`ATOMIC_AGENT_API_KEY`, else
 * `<stateDir>/serve-api.key`), build the CLI's env and args
 * (launch-integrations.ts), run it with the terminal attached and exit
 * with its exit code. Nothing is written to the CLI's own config files.
 *
 * The key is never printed: `--print-env` shows every variable but the
 * secret ones, which it masks.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { constants as osConstants } from "node:os";

import { resolveStateDir } from "../config/index.js";
import { findOnPath } from "./cloudflared.js";
import {
  DEFAULT_LAUNCH_MODEL,
  findLaunchIntegration,
  LAUNCH_INTEGRATIONS,
  type LaunchIntegration,
  type LaunchPlan,
} from "./launch-integrations.js";
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

export const LAUNCH_HELP = [
  "Usage: atomic-agent launch [<agent>] [--model <id>] [--print-env] [-- <agent args>]",
  "",
  "Start another coding CLI on Atomic Agent: it talks to `atag serve` on this machine",
  "(reused when one already runs in this folder, else started for this run and stopped after).",
  "",
  "Agents:",
  ...LAUNCH_INTEGRATIONS.map((i) => `  ${i.id.padEnd(9)} ${i.displayName} (${i.installHint})`),
  "",
  "Options:",
  "  --model <id>   Model name the CLI sends (default atomic-agent). The model active in",
  "                 Atomic Agent answers whatever the name is.",
  "  --print-env    Print the environment and command instead of running it (keys masked)",
  "  -- <args>      Passed to the agent unchanged, e.g. atag launch codex -- exec \"fix the tests\"",
  "",
  "Answers come from the Atomic Agent turn path (/v1/messages, /v1/responses, /v1/chat/completions):",
  "the agent runs its own tools; the launched CLI's own tool calls are not offered to the model.",
  "",
  "Approvals: a serve started here refuses every approval prompt at once (the CLI cannot show one),",
  "so the turn answers in text; a reused serve asks in its /panel page (the address is printed at start).",
  "",
  "Without an agent name, lists the CLIs above (installed or not) and, in a terminal, asks which to start.",
].join("\n");

export const MASKED = "<hidden: atag serve --print-api-key>";

/**
 * Where approvals go (ATO-2172 review): the launched CLI never shows
 * one. A serve started here refuses them at once; a reused one asks in
 * its /panel page.
 */
export function launchApprovalNote(serve: { baseUrl: string; started: boolean }): string {
  // ATO-2737: the real address, not a `<port>` placeholder. A serve the
  // person starts themselves listens on the default port.
  return serve.started
    ? `launch: approvals are refused on this serve (the CLI cannot show them); what needs one comes back as text. To approve instead, run \`atag serve --cwd .\` in another terminal and open ${loopbackBaseUrl(DEFAULT_SERVE_PORT)}/panel\n`
    : `launch: approval prompts from this serve wait in ${serve.baseUrl}/panel (or the desktop app)\n`;
}

export interface LaunchArgs {
  /** `null`: no agent named, so `atag launch` lists them and asks (ATO-2737). */
  readonly integration: LaunchIntegration | null;
  readonly model: string | null;
  readonly printEnv: boolean;
  readonly extraArgs: readonly string[];
}

export function parseLaunchArgs(args: readonly string[]): LaunchArgs | { error: string } | "help" {
  const dash = args.indexOf("--");
  const own = dash === -1 ? args : args.slice(0, dash);
  const extraArgs = dash === -1 ? [] : args.slice(dash + 1);
  let name: string | undefined;
  let model: string | null = null;
  let printEnv = false;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] as string;
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--print-env") printEnv = true;
    else if (arg === "--model") {
      const value = own[i + 1];
      if (!value || value.startsWith("-")) return { error: "--model expects a model id" };
      model = value;
      i++;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      if (!model) return { error: "--model expects a model id" };
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else if (name === undefined) name = arg;
    else return { error: `unexpected argument ${arg} (put the agent's own arguments after --)` };
  }
  if (!name) return { integration: null, model, printEnv, extraArgs };
  const integration = findLaunchIntegration(name);
  if (!integration) {
    return { error: `unknown agent ${name} (one of: ${LAUNCH_INTEGRATIONS.map((i) => i.id).join(", ")})` };
  }
  return { integration, model, printEnv, extraArgs };
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
  readonly findServe?: (stateDir: string, cwd: string) => Promise<LaunchServe | null>;
  readonly startServe?: (stateDir: string, cwd: string) => Promise<LaunchServe | { readonly error: string }>;
  readonly checkKey?: (baseUrl: string, token: string) => Promise<boolean>;
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

  const findServe = deps.findServe ?? ((s: string, c: string) => findReusableServe(s, c, deps.serveDeps));
  let serve = await findServe(stateDir, cwd);
  if (parsed.printEnv) {
    // Printing starts nothing: a serve started here would stop as soon as
    // this process exits.
    const baseUrl = serve?.baseUrl ?? loopbackBaseUrl(DEFAULT_SERVE_PORT);
    if (!serve) writeErr(`launch: no atag serve runs in ${cwd}; start one with: atag serve --cwd .\n`);
    write(formatPrintEnv(binaryPath ?? integration.binary, buildPlan(integration, parsed, baseUrl, key.key)));
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
  if (!(await (deps.checkKey ?? serveAcceptsKey)(serve.baseUrl, key.key))) {
    writeErr(
      `launch: the atag serve on port ${serve.port} does not accept the key from ATOMIC_AGENT_API_KEY or ` +
        "<stateDir>/serve-api.key (it was started with another --api-key). Set ATOMIC_AGENT_API_KEY to that key.\n",
    );
    return 1;
  }

  const plan = buildPlan(integration, parsed, serve.baseUrl, key.key);
  writeErr(`launch: ${integration.displayName} on Atomic Agent at ${serve.baseUrl}\n`);
  writeErr(launchApprovalNote(serve));
  return runChild(binaryPath as string, plan, env, deps.spawn ?? nodeSpawn, writeErr);
}

function buildPlan(integration: LaunchIntegration, parsed: LaunchArgs, baseUrl: string, token: string): LaunchPlan {
  return integration.build({
    baseUrl,
    token,
    model: parsed.model ?? DEFAULT_LAUNCH_MODEL,
    modelGiven: parsed.model !== null,
    extraArgs: parsed.extraArgs,
  });
}

/** cmd.exe quoting for a Windows `.cmd` / `.bat` shim, which only runs through a shell. */
function winQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Run the CLI with this terminal and forward its exit code. While it runs,
 * Ctrl+C belongs to the CLI (it is in the same process group and gets the
 * signal itself), so this process ignores SIGINT and passes SIGTERM and
 * SIGHUP on.
 */
export function runChild(
  binaryPath: string,
  plan: LaunchPlan,
  baseEnv: NodeJS.ProcessEnv,
  spawn: typeof nodeSpawn,
  writeErr: (text: string) => void,
): Promise<number> {
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath);
  const options: SpawnOptions = { stdio: "inherit", env: { ...baseEnv, ...plan.env }, ...(viaShell ? { shell: true } : {}) };
  const child = viaShell
    ? spawn(winQuote(binaryPath), plan.args.map(winQuote), options)
    : spawn(binaryPath, [...plan.args], options);
  const ignore = (): void => undefined;
  const forward = (sig: NodeJS.Signals) => (): void => {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGINT", ignore);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  const cleanup = (): void => {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  };
  return new Promise((resolveCode) => {
    child.once("error", (err) => {
      cleanup();
      writeErr(`launch: could not run ${binaryPath}: ${err.message}\n`);
      resolveCode(1);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code !== null) return resolveCode(code);
      const num = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
      resolveCode(num ? 128 + num : 1);
    });
  });
}
