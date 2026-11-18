import { resolveStateDir } from "../config/index.js";
import { formatPolicy, loadPolicy, type EffectivePolicy } from "../policy/index.js";

/**
 * ATO-587 — `atag policy show`: print the effective admin policy and
 * where each part came from (the machine-wide file, `<stateDir>/policy.json`,
 * `ATOMIC_POLICY_URL` or its cached copy). Read-only; `--json` for scripts.
 */
const HELP = [
  "Usage: atomic-agent policy show [--json]",
  "",
  "Print the organization policy this agent follows and where it came from:",
  "  the machine-wide file (macOS /Library/Application Support/AtomicAgent/policy.json,",
  "  Linux /etc/atomic-agent/policy.json, Windows %ProgramData%\\AtomicAgent\\policy.json),",
  "  <stateDir>/policy.json, and the URL in ATOMIC_POLICY_URL (last good copy when offline).",
].join("\n");

export interface PolicyCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  load?: () => Promise<EffectivePolicy>;
}

export async function policyCommand(args: string[], deps: PolicyCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== "show") {
    writeErr(`unknown subcommand ${sub}\n\n${HELP}\n`);
    return 2;
  }
  const unknown = rest.find((a) => a !== "--json");
  if (unknown !== undefined) {
    writeErr(`unknown option ${unknown}\n\n${HELP}\n`);
    return 2;
  }
  const policy = await (deps.load ?? (() => loadPolicy({ stateDir: resolveStateDir() })))();
  write(rest.includes("--json") ? `${JSON.stringify(policy, null, 2)}\n` : formatPolicy(policy));
  return 0;
}
