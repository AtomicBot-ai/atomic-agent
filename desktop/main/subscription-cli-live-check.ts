import type { SubscriptionCli } from "./subscription-cli-detect.js";

/**
 * ATO-1684: is the Claude Code / Codex CLI really signed in? Asked once when
 * the person picks the subscription in Add provider, so a dead login shows
 * its sign-in step right away instead of failing the first message.
 *
 * The login file (subscription-cli-detect.ts) cannot tell an expired login
 * from a good one, and on macOS Claude Code keeps the token in the Keychain.
 * So the CLI itself is asked, the way Zed and Continue check an agent CLI on
 * connect:
 *
 *   codex   `codex login status` (no model call)
 *   claude  `claude auth status` (no model call); a Claude Code too old to
 *           have it gets one tiny turn instead: `-p ok` on haiku, one turn,
 *           no tools, no MCP servers, no saved session
 *
 * This file is the pure half: what to run, how to read the answer, and the
 * per-session cache that keeps it to one run per pick. The spawn lives in
 * subscription-cli-live-check-ipc.ts. Only a state word, the fix command and
 * "API key login" come back; nothing the CLI printed (an e-mail, a key) does.
 */

export type LiveCheckState = "signed_in" | "signed_out" | "missing" | "failed";

/** How the answer was found. */
export type LiveCheckVia = "auth_status" | "turn" | "none";

export interface LiveCheck {
  cli: SubscriptionCli;
  state: LiveCheckState;
  via: LiveCheckVia;
  /** The command that signs in, for signed_out; null otherwise. */
  fix: string | null;
  /** Codex signed in with an API key, not ChatGPT: it bills per token. */
  apiKeyLogin?: boolean;
  /** Date.now() when the check finished. */
  checkedAt: number;
}

export interface LiveCheckStep {
  via: Exclude<LiveCheckVia, "none">;
  args: string[];
  timeoutMs: number;
}

/** What one run of the CLI gave back. */
export interface RunOutcome {
  /** null when it never started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The spawn failed: ENOENT means the binary is not there. */
  spawnError?: string;
}

/** The steps to try, in order; the next one runs only when a step says "unsupported". */
export function liveCheckSteps(cli: SubscriptionCli): LiveCheckStep[] {
  if (cli === "codex") return [{ via: "auth_status", args: ["login", "status"], timeoutMs: 10_000 }];
  return [
    { via: "auth_status", args: ["auth", "status"], timeoutMs: 10_000 },
    {
      via: "turn",
      args: ["-p", "ok", "--output-format", "json", "--max-turns", "1", "--model", "haiku",
        "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
      timeoutMs: 30_000,
    },
  ];
}

/** The sign-in command the wizard already shows (subscription-cli-login.ts runs the same). */
export function liveCheckFix(cli: SubscriptionCli): string {
  return cli === "codex" ? "codex login" : "claude";
}

/**
 * Variables that move the CLI off the plan (an API key, another endpoint).
 * Dropped from the check's environment so it asks about the subscription
 * login. Mirrors billingEnvKeys in src/llm/provider/subscription-cli.
 */
export const LIVE_CHECK_STRIP_ENV: Readonly<Record<SubscriptionCli, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
};

/** A signed-out CLI's own words. Mirrors AUTH_PATTERNS in subscription-cli-errors.ts. */
const SIGNED_OUT = [
  /\bplease run\s+\/login\b/i,
  /\brun\s+`?\/login`?\b/i,
  /\bnot (?:logged in|authenticated|signed in)\b/i,
  /\bauthentication (?:required|failed|error)\b/i,
  /\binvalid api key\b/i,
  /\bunauthorized\b/i,
  /\bcredentials (?:are )?(?:missing|expired|invalid)\b/i,
  /\bauthentication_failed\b/i,
  /\bfailed to authenticate\b/i,
  /\boauth (?:session|token) (?:has )?expired\b/i,
];

/** An older CLI that does not know the subcommand. */
const UNSUPPORTED = /\bunknown (?:command|option|subcommand|argument)\b|\bunrecognized\b|\bdid you mean\b|^\s*usage:/im;

/** cmd.exe could not find it. */
const NOT_FOUND = /is not recognized as an internal or external command/i;

function looksSignedOut(text: string): boolean {
  return SIGNED_OUT.some((re) => re.test(text));
}

function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One step's verdict: a state, or "unsupported" (try the next step). */
export type StepVerdict = { state: LiveCheckState; apiKeyLogin?: boolean } | "unsupported";

export function readStep(cli: SubscriptionCli, step: LiveCheckStep, out: RunOutcome): StepVerdict {
  if (out.spawnError === "ENOENT") return { state: "missing" };
  if (out.spawnError) return { state: "failed" };
  if (out.timedOut) return { state: "failed" };
  const said = `${out.stdout}\n${out.stderr}`;
  if (NOT_FOUND.test(said)) return { state: "missing" };

  if (cli === "codex") {
    // "Logged in using ChatGPT" or "Logged in using an API key - sk-...".
    if (out.code === 0) {
      if (/api key/i.test(said) && !/chatgpt/i.test(said)) return { state: "signed_out", apiKeyLogin: true };
      return { state: "signed_in" };
    }
    return looksSignedOut(said) ? { state: "signed_out" } : { state: "failed" };
  }

  if (step.via === "auth_status") {
    // `claude auth status` prints JSON with `loggedIn`, exit 0 signed in, 1 not.
    const json = parseObject(out.stdout);
    if (json && typeof json.loggedIn === "boolean") return { state: json.loggedIn ? "signed_in" : "signed_out" };
    if (looksSignedOut(said)) return { state: "signed_out" };
    if (UNSUPPORTED.test(said)) return "unsupported";
    if (out.code === 0) return /\blogged in\b/i.test(said) ? { state: "signed_in" } : "unsupported";
    return "unsupported";
  }

  // The tiny turn: the JSON result envelope says whether it answered.
  const json = parseObject(out.stdout);
  if (json && typeof json.is_error === "boolean") {
    if (!json.is_error && out.code === 0) return { state: "signed_in" };
    return looksSignedOut(said) ? { state: "signed_out" } : { state: "failed" };
  }
  if (looksSignedOut(said)) return { state: "signed_out" };
  return { state: "failed" };
}

export type StepRunner = (step: LiveCheckStep) => Promise<RunOutcome>;

/** Run the steps in order until one gives a state. */
export async function runLiveCheck(cli: SubscriptionCli, run: StepRunner, now: () => number = Date.now): Promise<LiveCheck> {
  for (const step of liveCheckSteps(cli)) {
    let out: RunOutcome;
    try {
      out = await run(step);
    } catch {
      return finish(cli, { state: "failed" }, step.via, now);
    }
    const verdict = readStep(cli, step, out);
    if (verdict === "unsupported") continue;
    return finish(cli, verdict, step.via, now);
  }
  return finish(cli, { state: "failed" }, "none", now);
}

function finish(cli: SubscriptionCli, v: { state: LiveCheckState; apiKeyLogin?: boolean }, via: LiveCheckVia, now: () => number): LiveCheck {
  return {
    cli,
    state: v.state,
    via,
    fix: v.state === "signed_out" ? liveCheckFix(cli) : null,
    ...(v.apiKeyLogin ? { apiKeyLogin: true } : {}),
    checkedAt: now(),
  };
}

/** A forced check sooner than this after the last one gets the last answer. */
export const LIVE_CHECK_MIN_GAP_MS = 5_000;

/**
 * One answer per CLI for the app's session. A second ask while a check runs
 * shares it; `force` ("Check again", or after Sign in) runs again, but not
 * within LIVE_CHECK_MIN_GAP_MS of the last one, so a burst of clicks or a
 * poll never turns into a burst of runs.
 */
export class LiveCheckCache {
  private readonly done = new Map<SubscriptionCli, LiveCheck>();
  private readonly running = new Map<SubscriptionCli, Promise<LiveCheck>>();

  constructor(
    private readonly check: (cli: SubscriptionCli) => Promise<LiveCheck>,
    private readonly now: () => number = Date.now,
  ) {}

  get(cli: SubscriptionCli, force = false): Promise<LiveCheck> {
    const inFlight = this.running.get(cli);
    if (inFlight) return inFlight;
    const last = this.done.get(cli);
    if (last && (!force || this.now() - last.checkedAt < LIVE_CHECK_MIN_GAP_MS)) return Promise.resolve(last);
    const p = this.check(cli)
      .then((r) => { this.done.set(cli, r); return r; })
      .finally(() => { this.running.delete(cli); });
    this.running.set(cli, p);
    return p;
  }
}
