import { getUserConfigPath, readUserConfigFileSync, resolveStateDir } from "../config/index.js";
import { SUBSCRIPTION_CLIS, type SubscriptionCliName } from "../config/llm-config.js";
import {
  checkSubscriptionCli,
  registerBuiltInCliAdapters,
  resolveCliAdapter,
  type SubscriptionCliStatusReport,
} from "../llm/provider/subscription-cli/index.js";

/**
 * ATO-1200 — `atomic-agent providers status`: is the Claude Code / Codex CLI
 * installed and signed in? The terminal wizard (ATO-1204) and the desktop use
 * the same answer. Runs `--version` and, for Codex, `codex login status`;
 * never a turn, so it never spends the plan. Exit 0 when every CLI asked
 * about is ready, 1 when one is not, 2 on a usage error.
 */
const HELP = [
  "Usage: atomic-agent providers status [--cli claude|codex] [--json]",
  "",
  "Checks the subscription CLIs (Claude Code, Codex): installed, signed in, version.",
  "Nothing is sent to Anthropic or OpenAI, so it does not use your plan.",
  "",
  "  --cli <name>   Check one CLI (default: both)",
  "  --json         One JSON object per CLI, in an array",
].join("\n");

export interface ProvidersCommandDeps {
  write?: (text: string) => void;
  stateDir?: string;
  check?: (cli: SubscriptionCliName, binPath: string | undefined) => Promise<SubscriptionCliStatusReport>;
  /** binPath per CLI from config; default reads llm.providers[] in config.json. */
  binPaths?: () => Partial<Record<SubscriptionCliName, string>>;
}

/** `subscriptionCli.binPath` of the first configured entry for each CLI. */
function configuredBinPaths(stateDir: string): Partial<Record<SubscriptionCliName, string>> {
  const out: Partial<Record<SubscriptionCliName, string>> = {};
  let file;
  try {
    file = readUserConfigFileSync(getUserConfigPath(stateDir));
  } catch {
    return out;
  }
  for (const p of file?.llm?.providers ?? []) {
    const sub = p.subscriptionCli;
    if (sub && sub.binPath && !out[sub.cli]) out[sub.cli] = sub.binPath;
  }
  return out;
}

const STATE_WORD: Record<SubscriptionCliStatusReport["state"], string> = {
  ready: "ready",
  signed_out: "signed out",
  missing: "not installed",
  unknown: "can't verify login",
};

export function formatStatusLine(r: SubscriptionCliStatusReport): string {
  const head = `${r.productName.padEnd(12)} ${STATE_WORD[r.state].padEnd(18)} ${(r.version ?? "-").padEnd(10)}`;
  const tail = r.fix ? `run: ${r.fix}` : r.message;
  const billing = r.billingEnvSet.length
    ? `\n${" ".repeat(13)}${r.billingEnvSet.join(", ")} set: the CLI may bill per token instead of your plan`
    : "";
  return `${head} ${tail}${billing}`;
}

export async function providersCommand(args: string[], deps: ProvidersCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  if (sub !== "status") {
    write(`unknown providers command "${sub}"\n\n${HELP}\n`);
    return 2;
  }

  let only: SubscriptionCliName | null = null;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") { json = true; continue; }
    const value = a === "--cli" ? rest[++i] : a.startsWith("--cli=") ? a.slice(6) : undefined;
    if (a === "--cli" || a.startsWith("--cli=")) {
      if (!value || !(SUBSCRIPTION_CLIS as readonly string[]).includes(value)) {
        write(`--cli must be one of: ${SUBSCRIPTION_CLIS.join(", ")}\n`);
        return 2;
      }
      only = value as SubscriptionCliName;
      continue;
    }
    write(`unknown option "${a}"\n\n${HELP}\n`);
    return 2;
  }

  const clis: SubscriptionCliName[] = only ? [only] : [...SUBSCRIPTION_CLIS];
  const binPaths = (deps.binPaths ?? (() => configuredBinPaths(deps.stateDir ?? resolveStateDir())))();
  const check = deps.check ?? ((cli, binPath) => {
    registerBuiltInCliAdapters();
    return checkSubscriptionCli(resolveCliAdapter(cli), binPath ? { binPath } : {});
  });
  const reports = await Promise.all(clis.map((cli) => check(cli, binPaths[cli])));

  if (json) write(`${JSON.stringify(reports, null, 2)}\n`);
  else write(`${reports.map(formatStatusLine).join("\n")}\n`);
  return reports.every((r) => r.state === "ready") ? 0 : 1;
}
