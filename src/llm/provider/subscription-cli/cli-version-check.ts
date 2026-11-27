import type { SubscriptionCliName } from "../../../config/llm-config.js";
import { CODEX_UPDATE } from "./cli-exit-hint.js";
import type { CliRunner } from "./run-cli-completion.js";
import { SubscriptionCliInvocationError } from "./subscription-cli-errors.js";

/**
 * Is the person's Claude Code or Codex new enough for the flags our
 * adapters pass (ATO-1685)?
 *
 * Before this, an old CLI showed only after a failed turn, as
 * "unknown option" plus the `claude update` hint of `cli-exit-hint.ts`.
 * Now `<cli> --version` runs once per process and binary, before the
 * first turn, with a hard cap of a few seconds; it never fails a turn
 * and never holds one longer than the cap. Precedent: Zed and Continue
 * check the agent CLI when they connect to it, and Claude Code warns
 * about its own outdated versions.
 *
 * The minimums come from the flags `claude-cli-adapter.ts` and
 * `codex-cli-adapter.ts` always pass:
 *
 *  - Codex 0.122.0: the first release whose `codex exec` accepts
 *    `--ignore-user-config` (checked against `codex-rs/exec/src/cli.rs`
 *    at each release tag: absent in rust-v0.121.0, present in
 *    rust-v0.122.0). `--ephemeral` came in 0.99.0, the rest earlier.
 *  - Claude Code 2.1.22: conservative. The changelog has no "added" line
 *    for `--no-session-persistence`, `--strict-mcp-config` or
 *    `--json-schema`; `--tools` was there by 2.1.0 and 2.1.22 fixed
 *    structured output in `-p` mode, which `--json-schema` relies on.
 *  - Claude Code on Windows 2.1.120: before it Claude Code exits at
 *    start without Git for Windows (changelog 2.1.120, "Git Bash is no
 *    longer required").
 */
const MINIMUM_VERSIONS: Readonly<Record<SubscriptionCliName, { default: string; win32?: string }>> = {
  claude: { default: "2.1.22", win32: "2.1.120" },
  codex: { default: "0.122.0" },
};

/** The cap on one check, including a CLI that never answers. */
export const CLI_VERSION_CHECK_TIMEOUT_MS = 3_000;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

/** The oldest version we support for this CLI on this platform. */
export function minimumCliVersion(cli: SubscriptionCliName, platform: NodeJS.Platform): string {
  const entry = MINIMUM_VERSIONS[cli];
  return (platform === "win32" ? entry.win32 : undefined) ?? entry.default;
}

const VERSION_RE = /\b(\d+)\.(\d+)\.(\d+)\b/;

/** `x.y.z` from `--version` output ("2.1.328 (Claude Code)", "codex-cli 0.172.0"), else null. */
export function parseCliVersion(text: string): string | null {
  const match = VERSION_RE.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** How a person updates this CLI. */
export function cliUpdateCommand(cli: SubscriptionCliName): string {
  return cli === "claude" ? "`claude update`" : CODEX_UPDATE;
}

/** The sentence for an outdated CLI, ending with a full stop. */
export function outdatedCliMessage(
  cli: SubscriptionCliName,
  productName: string,
  version: string,
  minimum: string,
): string {
  return `${productName} ${version} is older than ${minimum}, the oldest version Atomic Agent works with. Update it with ${cliUpdateCommand(cli)}, then retry.`;
}

export interface CliVersionVerdict {
  /** `x.y.z`, or null when `--version` printed none, failed or hung. */
  version: string | null;
  minimum: string;
  /** True only when a version was read and it is below the minimum. */
  outdated: boolean;
  /** The outdated sentence, or null when there is nothing to say. */
  message: string | null;
}

export interface CliVersionCheckInput {
  cli: SubscriptionCliName;
  productName: string;
  binary: string;
  cwd: string;
  run: CliRunner;
  installHint: string;
  authHint: string;
  stripEnv: readonly string[];
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export type CliVersionCheck = (input: CliVersionCheckInput) => Promise<CliVersionVerdict>;

/** One answer per CLI and binary for the life of the process. */
const verdicts = new Map<string, Promise<CliVersionVerdict>>();

/**
 * The cached verdict for this CLI and binary, checking on first use.
 * Never rejects: a missing binary, a crash or a hang is "no version",
 * and the turn itself reports what is wrong.
 */
export const checkCliVersionOnce: CliVersionCheck = (input) => {
  const key = `${input.cli}\u0000${input.binary}`;
  const cached = verdicts.get(key);
  if (cached) return cached;
  const verdict = readVerdict(input);
  verdicts.set(key, verdict);
  return verdict;
};

/** Test seam: forget every cached verdict. */
export function resetCliVersionChecks(): void {
  verdicts.clear();
}

async function readVerdict(input: CliVersionCheckInput): Promise<CliVersionVerdict> {
  const minimum = minimumCliVersion(input.cli, input.platform ?? process.platform);
  const unknown: CliVersionVerdict = { version: null, minimum, outdated: false, message: null };
  const timeoutMs = input.timeoutMs ?? CLI_VERSION_CHECK_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  // The runner has its own timeout and kills the child; this race is
  // the promise that the turn is never held past the cap regardless.
  const capped = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      input.run({
        binary: input.binary,
        args: ["--version"],
        cwd: input.cwd,
        timeoutMs,
        maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
        installHint: input.installHint,
        authHint: input.authHint,
        productName: input.productName,
        stripEnv: input.stripEnv,
      }),
      capped,
    ]);
    if (outcome === null) return unknown;
    const version = parseCliVersion(`${outcome.stdout}\n${outcome.stderr}`);
    if (version === null) return unknown;
    const outdated = compareCliVersions(version, minimum) < 0;
    return {
      version,
      minimum,
      outdated,
      message: outdated ? outdatedCliMessage(input.cli, input.productName, version, minimum) : null,
    };
  } catch {
    return unknown;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Put the outdated sentence in front of a failed run's message and flag
 * it for the error report (`cli_version_outdated`). Only for an
 * invocation failure: a signed-out CLI or a spent limit has its own
 * explanation, and the version would only distract from it. In front,
 * not behind, so the message still ends with the CLI's own words.
 */
export function noteOutdatedCli(err: unknown, verdict: CliVersionVerdict | null): unknown {
  if (!verdict?.outdated || verdict.message === null) return err;
  if (!(err instanceof SubscriptionCliInvocationError)) return err;
  if (err.failureKind === "limit_reached" || err.failureKind === "plan_required") return err;
  Object.assign(err, { cliVersionOutdated: true });
  // `cli-exit-hint.ts` already said "may be older" for a refused flag.
  if (!err.message.includes("may be older than this version")) {
    err.message = `${verdict.message} ${err.message}`;
  }
  return err;
}

/** `noteOutdatedCli` for a streamed run: the lines pass through untouched. */
export async function* noteOutdatedOnThrow<T>(
  source: AsyncGenerator<T, void, void>,
  verdict: CliVersionVerdict | null,
): AsyncGenerator<T, void, void> {
  try {
    // `yield*` forwards an early `return()` to the source, so its
    // `finally` still stops the child when the consumer walks away.
    yield* source;
  } catch (err) {
    throw noteOutdatedCli(err, verdict);
  }
}
