import { createInterface } from "node:readline/promises";

import { getConfig } from "../config/index.js";
import {
  applySkillUpdate,
  checkSkillUpdates,
  ClawHubClient,
  rollbackSkillUpdate,
  SkillHubInstallError,
  summarizeScan,
  type ScanGateOptions,
  type SkillHubClient,
  type SkillUpdatePreview,
  type SkillUpdateStatus,
} from "../skills/index.js";
import { formatScanFindings } from "./skill-install-confirm.js";

export const UPDATE_USAGE =
  "usage: atomic-agent skill update [<name>...] [--check] [--yes] [--acknowledge-risk] | skill update --rollback <name>";

export interface UpdateCommandDeps {
  /** Defaults to stdin *and* stdout being a TTY. */
  isTTY?: () => boolean;
  /** Free-text prompt. Defaults to a readline question. */
  ask?: (prompt: string) => Promise<string>;
  /** Source clients (tests). Defaults to the configured ClawHub and GitHub. */
  github?: SkillHubClient;
  clawhub?: ClawHubClient;
  tmpRoot?: string;
}

/**
 * `skill update`: skills installed from GitHub taps or ClawHub only.
 * Third-party skills never change without the person agreeing:
 *  - `--check` lists what is outdated and changes nothing;
 *  - in a terminal, each outdated skill (or each named one) is staged and
 *    re-scanned, then the person sees the version change and the scan
 *    verdict and is asked before the installed copy is replaced;
 *  - `--yes` is the explicit opt-in: updates that pass the scan gate are
 *    replaced without the question (dangerous still needs
 *    `--acknowledge-risk`);
 *  - without a terminal and without `--yes`, it only reports what has an
 *    update and replaces nothing;
 *  - a skill edited by hand is reported and skipped, never overwritten;
 *  - `--rollback <name>` puts back the copy the last update replaced.
 * Exit code 1 when any skill could not be checked or updated.
 */
export async function handleUpdate(
  args: string[],
  deps: UpdateCommandDeps = {},
): Promise<number> {
  const config = getConfig();
  const targetRoot = config.paths.globalSkillsDir;
  const rollbackAt = args.indexOf("--rollback");
  if (rollbackAt >= 0) {
    const name = args[rollbackAt + 1];
    if (!name || name.startsWith("-")) {
      process.stderr.write(`${UPDATE_USAGE}\n`);
      return 2;
    }
    const result = await rollbackSkillUpdate({ targetRoot, name });
    process.stdout.write(`rolled back ${result.name}; the replaced copy is kept at ${result.restoredFrom}\n`);
    return 0;
  }

  const names = args.filter((a) => !a.startsWith("-"));
  const sources = {
    clawhub: deps.clawhub ?? new ClawHubClient({ apiBase: config.skills.clawhub.apiBase }),
    ...(deps.github ? { github: deps.github } : {}),
    ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
  };
  const statuses = await checkSkillUpdates({
    targetRoot,
    ...(names.length > 0 ? { names } : {}),
    ...sources,
  });
  if (names.length > 0) {
    const tracked = new Set(statuses.map((s) => s.name));
    for (const n of names.filter((n) => !tracked.has(n))) {
      process.stderr.write(`${n}: not installed from a skill hub; skipped\n`);
    }
  }
  if (statuses.length === 0) {
    process.stdout.write("no skills installed from a skill hub\n");
    return 0;
  }

  let failed = statuses.some((s) => s.state === "error");
  for (const s of statuses) process.stdout.write(`${formatStatus(s)}\n`);
  if (args.includes("--check")) return failed ? 1 : 0;
  const outdated = statuses.filter((x) => x.state === "update_available");
  if (outdated.length === 0) return failed ? 1 : 0;

  const optedIn = args.includes("--yes") || args.includes("-y");
  const isTTY =
    deps.isTTY ??
    (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const interactive = isTTY();
  if (!optedIn && !interactive) {
    process.stdout.write(
      `${outdated.length} skill update${outdated.length === 1 ? "" : "s"} available; nothing was replaced. Run \`atomic-agent skill update --yes\` to install ${outdated.length === 1 ? "it" : "them"}.\n`,
    );
    return failed ? 1 : 0;
  }

  const ask = deps.ask ?? defaultAsk;
  // With the question, the caution findings are part of it, so one
  // answer covers both; dangerous still needs --acknowledge-risk.
  const gate: ScanGateOptions = {
    acknowledgeRisk: args.includes("--acknowledge-risk"),
    confirmCaution: true,
  };
  const confirmUpdate = optedIn
    ? undefined
    : async (p: SkillUpdatePreview): Promise<boolean> => {
        process.stderr.write(formatPreview(p));
        const answer = await ask(`Replace the installed ${p.name}? [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      };
  for (const s of outdated) {
    try {
      const r = await applySkillUpdate({
        targetRoot,
        name: s.name,
        ...sources,
        ...gate,
        ...(confirmUpdate ? { confirmUpdate } : {}),
      });
      if (r.state === "updated") {
        process.stdout.write(
          `updated ${r.name} to ${shortVersion(r.toVersion)} — ${r.scan ? summarizeScan(r.scan) : "scanned"}; previous copy kept (skill update --rollback ${r.name})\n`,
        );
      } else if (r.state === "declined") {
        process.stdout.write(`${r.name}: not updated, the installed version is kept\n`);
      } else {
        process.stdout.write(`${r.name}: files unchanged, nothing to do\n`);
      }
    } catch (err) {
      failed = true;
      reportUpdateError(s.name, err);
    }
  }
  return failed ? 1 : 0;
}

/** Shown before the question: what changes and what the scan said. */
export function formatPreview(p: SkillUpdatePreview): string {
  return (
    `${p.name}: update ${shortVersion(p.fromVersion)} -> ${shortVersion(p.toVersion)} (${p.identifier})\n` +
    formatScanFindings(p.scan)
  );
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function formatStatus(s: SkillUpdateStatus): string {
  const from = shortVersion(s.installedVersion);
  const to = shortVersion(s.latestVersion ?? "");
  switch (s.state) {
    case "up_to_date":
      return `${s.name}\tup to date (${from})\t${s.identifier}`;
    case "update_available":
      return `${s.name}\tupdate available ${from} -> ${to}\t${s.identifier}`;
    case "locally_modified":
      return s.updateBlocked
        ? `${s.name}\tchanged locally; update ${to} not applied\t${s.identifier}`
        : `${s.name}\tchanged locally since install\t${s.identifier}`;
    case "error":
      return `${s.name}\tcheck failed: ${s.error ?? "unknown error"}\t${s.identifier}`;
  }
}

function reportUpdateError(name: string, err: unknown): void {
  if (err instanceof SkillHubInstallError && err.scan) {
    process.stderr.write(formatScanFindings(err.scan));
    const hint = err.code === "needs_confirmation" ? "--yes" : "--acknowledge-risk";
    process.stderr.write(`${name}: update refused by the security scan (${summarizeScan(err.scan)}); the installed version is kept (re-run with ${hint} to override)\n`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${name}: update failed: ${message}\n`);
}

/** Commit shas are 40 hex chars; show 12 like `git log --abbrev`. */
function shortVersion(version: string): string {
  if (version === "") return "unknown version";
  return /^[0-9a-f]{40,64}$/.test(version) ? version.slice(0, 12) : version;
}
