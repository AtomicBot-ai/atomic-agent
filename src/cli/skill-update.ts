import { getConfig } from "../config/index.js";
import {
  applySkillUpdate,
  checkSkillUpdates,
  ClawHubClient,
  rollbackSkillUpdate,
  SkillHubInstallError,
  summarizeScan,
  type ScanGateOptions,
  type SkillUpdateStatus,
} from "../skills/index.js";
import {
  createInstallConfirm,
  formatScanFindings,
} from "./skill-install-confirm.js";

export const UPDATE_USAGE =
  "usage: atomic-agent skill update [<name>...] [--check] [--yes] [--acknowledge-risk] | skill update --rollback <name>";

/**
 * `skill update`: skills installed from GitHub taps or ClawHub only.
 *  - `--check` lists what is outdated and changes nothing;
 *  - otherwise each outdated skill (or each named one) is staged,
 *    re-scanned and swapped in through the same gate as `skill install`;
 *  - a skill edited by hand is reported and skipped, never overwritten;
 *  - `--rollback <name>` puts back the copy the last update replaced.
 * Exit code 1 when any skill could not be checked or updated.
 */
export async function handleUpdate(args: string[]): Promise<number> {
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
    clawhub: new ClawHubClient({ apiBase: config.skills.clawhub.apiBase }),
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

  const gate: ScanGateOptions = {
    acknowledgeRisk: args.includes("--acknowledge-risk"),
    confirmCaution: args.includes("--yes") || args.includes("-y"),
    confirm: createInstallConfirm({ question: "Update this skill anyway? [y/N] " }),
  };
  for (const s of statuses.filter((x) => x.state === "update_available")) {
    try {
      const r = await applySkillUpdate({ targetRoot, name: s.name, ...sources, ...gate });
      process.stdout.write(
        r.state === "updated"
          ? `updated ${r.name} to ${shortVersion(r.toVersion)} — ${r.scan ? summarizeScan(r.scan) : "scanned"}; previous copy kept (skill update --rollback ${r.name})\n`
          : `${r.name}: files unchanged, nothing to do\n`,
      );
    } catch (err) {
      failed = true;
      reportUpdateError(s.name, err, gate);
    }
  }
  return failed ? 1 : 0;
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

function reportUpdateError(name: string, err: unknown, gate: ScanGateOptions): void {
  if (err instanceof SkillHubInstallError && err.scan) {
    if (err.code === "needs_confirmation" && gate.confirm) {
      process.stderr.write(`${name}: update cancelled, the installed version is kept\n`);
      return;
    }
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
