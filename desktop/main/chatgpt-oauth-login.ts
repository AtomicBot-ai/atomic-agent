/**
 * ATO-1741 / ATO-1744: "Sign in with ChatGPT" in the provider wizard without a
 * terminal or the Codex CLI. The bundled agent does the sign-in
 * (`atag login chatgpt --no-browser`, src/cli/login-command.ts): it starts the
 * loopback receiver, prints the `https://auth.openai.com/oauth/authorize?...`
 * link and waits for the browser to come back. This module runs it, opens that
 * link and waits for the exit; the IPC (chatgpt-oauth-ipc.ts) only wires it.
 *
 * What never leaves this module: the link, the process's output, a token. The
 * window gets `{ ok, state, reason, providerId? }` and, from status, only
 * signed-in / plan / supported. The output is read, never logged.
 *
 * One sign-in at a time: a second start while one runs joins it instead of
 * spawning a second process (the agent's receiver holds ports 1455/1457 and a
 * second one would fail on them anyway).
 *
 * Electron-free (openExternal, spawn and run are injected) so it is under
 * unit test (desktop/test/chatgpt-oauth-login.test.mjs).
 */

export type ChatgptOauthReason = "timeout" | "no_account" | "cancelled" | "failed";

export interface ChatgptOauthResult {
  ok: boolean;
  state: "signed_in" | "failed";
  reason?: ChatgptOauthReason;
  /** The provider entry the agent added or reused; the wizard activates it. */
  providerId?: string;
}

export interface ChatgptOauthStatus {
  ok: boolean;
  signedIn: boolean;
  plan: string | null;
  /** The bundled agent has `atag login chatgpt` (ATO-1744). */
  supported: boolean;
}

/** The part of a ChildProcess this module uses. */
export interface OauthChild {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ChatgptOauthDeps {
  /** The bundled agent's path (agent-client.ts resolveBinary), or null. */
  binary: () => string | null;
  /** Starts `binary args` with agentEnv(), no shell, stdout piped. */
  spawn: (binary: string, args: string[]) => OauthChild;
  /** A short `atag` run that returns its output, also on a non-zero exit. */
  run: (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
  /** shell.openExternal. */
  openExternal: (url: string) => Promise<void>;
  platform: NodeJS.Platform;
  /** The whole wait; the agent gives up at 10 minutes, this is a backstop. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A little over the agent's own 10-minute browser wait (BROWSER_TIMEOUT_MS). */
export const LOGIN_TIMEOUT_MS = 11 * 60_000;
/** After SIGINT, how long the agent gets to close its receiver before a hard kill. */
const CANCEL_GRACE_MS = 5_000;
/** Enough for the link and the result lines; the rest is dropped, never kept. */
const MAX_OUTPUT = 64 * 1024;

/** The whole link: it counts only once the line after it has begun (a chunk can end mid-link). */
const AUTH_URL = /https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"'<>]+(?=\s)/;
/** Any sign-in link, to catch one for another host. */
const ANY_AUTHORIZE = /\b(https?):\/\/([^/\s"'<>]+)\/oauth\/authorize\?/;
/** `Added provider "chatgpt-sub" ...` or `Provider "chatgpt-sub" now uses this sign-in.` */
const PROVIDER_LINE = /(?:Added provider|Provider) "([A-Za-z0-9._-]{1,64})"/;

/** The sign-in link in the agent's output, only when its host is exactly auth.openai.com. */
export function authorizationUrlIn(output: string): string | null {
  const m = AUTH_URL.exec(output);
  if (!m) return null;
  try {
    const url = new URL(m[0]);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.port !== "" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The provider entry id the agent named on success. */
export function providerIdIn(output: string): string | undefined {
  return PROVIDER_LINE.exec(output)?.[1];
}

/**
 * Why a sign-in that exited non-zero failed, from the agent's own fixed
 * sentences (describeLoginFailure in src/cli/login-command.ts).
 */
export function failureReason(output: string): ChatgptOauthReason {
  if (/Sign-in cancelled\./.test(output)) return "cancelled";
  if (/Sign-in timed out/.test(output)) return "timeout";
  if (/names no ChatGPT account/.test(output)) return "no_account";
  return "failed";
}

/** `atag login --help` lists `login chatgpt`; an agent without it says "unknown command". */
export function helpHasChatgptLogin(output: string): boolean {
  if (/unknown command/i.test(output)) return false;
  return /\blogin chatgpt\b/.test(output);
}

/** `atag login status --json` → only signed-in and plan. Anything else reads as not signed in. */
export function parseLoginStatus(stdout: string): { signedIn: boolean; plan: string | null } {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return { signedIn: false, plan: null };
  try {
    const report = JSON.parse(stdout.slice(start, end + 1)) as { signedIn?: unknown; plan?: unknown };
    const plan = typeof report.plan === "string" && /^[A-Za-z0-9 _-]{1,32}$/.test(report.plan) ? report.plan : null;
    return { signedIn: report.signedIn === true, plan };
  } catch {
    return { signedIn: false, plan: null };
  }
}

export interface ChatgptOauth {
  start(): Promise<ChatgptOauthResult>;
  /** Stops the running sign-in; true when one was running. */
  cancel(): boolean;
  running(): boolean;
  status(): Promise<ChatgptOauthStatus>;
  /** Once per app run (cached): whether the bundled agent has `login chatgpt`. */
  supported(): Promise<boolean>;
}

export function createChatgptOauth(deps: ChatgptOauthDeps): ChatgptOauth {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let current: { promise: Promise<ChatgptOauthResult>; stop: (why: "cancelled" | "timeout" | "failed") => void } | null = null;
  let supportedOnce: Promise<boolean> | null = null;

  function begin(): Promise<ChatgptOauthResult> {
    const binary = deps.binary();
    if (!binary) return Promise.resolve({ ok: false, state: "failed", reason: "failed" });
    let child: OauthChild;
    try {
      child = deps.spawn(binary, ["login", "chatgpt", "--no-browser"]);
    } catch {
      return Promise.resolve({ ok: false, state: "failed", reason: "failed" });
    }
    let output = "";
    let opened = false;
    let stopped: "cancelled" | "timeout" | "failed" | null = null;
    let hardKill: unknown = null;
    let settle!: (r: ChatgptOauthResult) => void;
    const promise = new Promise<ChatgptOauthResult>((resolve) => { settle = resolve; });
    let done = false;
    const timer = setTimer(() => stop("timeout"), deps.timeoutMs ?? LOGIN_TIMEOUT_MS);

    const finish = (r: ChatgptOauthResult): void => {
      if (done) return;
      done = true;
      clearTimer(timer);
      if (hardKill !== null) clearTimer(hardKill);
      output = "";
      if (current?.promise === promise) current = null;
      settle(r);
    };

    function stop(why: "cancelled" | "timeout" | "failed"): void {
      if (done || stopped) return;
      stopped = why;
      try {
        // The agent turns SIGINT into "Sign-in cancelled." and closes its
        // receiver; Windows has no SIGINT for a child, so it is ended outright.
        if (deps.platform === "win32") child.kill();
        else child.kill("SIGINT");
      } catch { /* already gone */ }
      if (deps.platform !== "win32") {
        hardKill = setTimer(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, CANCEL_GRACE_MS);
      }
    }

    child.stdout?.on("data", (chunk) => {
      if (output.length < MAX_OUTPUT) output += String(chunk);
      if (opened || stopped) return;
      const url = authorizationUrlIn(output);
      if (!url) {
        // A sign-in link for any other host is never opened.
        const other = ANY_AUTHORIZE.exec(output);
        if (other && (other[1] !== "https" || other[2] !== "auth.openai.com")) stop("failed");
        return;
      }
      opened = true;
      deps.openExternal(url).catch(() => stop("failed"));
    });
    child.on("error", () => finish({ ok: false, state: "failed", reason: stopped ?? "failed" }));
    child.on("exit", (code) => {
      if (code === 0 && !stopped) {
        const providerId = providerIdIn(output);
        finish({ ok: true, state: "signed_in", ...(providerId ? { providerId } : {}) });
        return;
      }
      finish({ ok: false, state: "failed", reason: stopped ?? failureReason(output) });
    });

    current = { promise, stop };
    return promise;
  }

  async function supported(): Promise<boolean> {
    supportedOnce ??= (async () => {
      if (!deps.binary()) return false;
      try {
        const r = await deps.run(["login", "--help"], 15_000);
        return helpHasChatgptLogin(`${r.stdout}\n${r.stderr}`);
      } catch {
        return false;
      }
    })();
    return supportedOnce;
  }

  return {
    start: () => current?.promise ?? begin(),
    cancel: () => {
      if (!current) return false;
      current.stop("cancelled");
      return true;
    },
    running: () => current !== null,
    supported,
    async status() {
      const isSupported = await supported();
      if (!isSupported) return { ok: true, signedIn: false, plan: null, supported: false };
      try {
        const r = await deps.run(["login", "status", "--json"], 15_000);
        return { ok: true, ...parseLoginStatus(r.stdout), supported: true };
      } catch {
        return { ok: false, signedIn: false, plan: null, supported: true };
      }
    },
  };
}
