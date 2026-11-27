/**
 * ATO-1684: the route behind the subscription step's live sign-in check
 * (the pure half is subscription-cli-live-check.ts).
 *
 *   cli:subscriptionLiveCheck  {cli, force?} -> {ok, check}
 *
 * Runs only the fixed commands liveCheckSteps lists, with the binary the
 * detector found (an off-PATH path only when it is a plain path, as Sign in
 * does), in the temp folder, without the variables that would move the CLI
 * off the plan. Output is capped, read for a state word and dropped.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

import { ipcMain } from "electron";

import { detectSubscriptionCli, isSubscriptionCli, type SubscriptionCli } from "./subscription-cli-detect.js";
import { loginBinary } from "./subscription-cli-login.js";
import { collectLiveCheckChild, type LiveCheckChild } from "./live-check-child.js";
import {
  LIVE_CHECK_STRIP_ENV, LiveCheckCache, runLiveCheck,
  type LiveCheck, type LiveCheckStep, type RunOutcome,
} from "./subscription-cli-live-check.js";

const MAX_OUTPUT = 64 * 1024;

/** The app's environment minus the billing variables, with an off-PATH binary's folder appended to PATH. */
function childEnv(cli: SubscriptionCli, bin: string): NodeJS.ProcessEnv {
  const drop = new Set(LIVE_CHECK_STRIP_ENV[cli].map((k) => k.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop.has(k.toUpperCase())) env[k] = v;
  const path = process.platform === "win32" ? win32 : posix;
  if (path.isAbsolute(bin)) {
    // An npm-installed CLI is a `node` script; its `node` sits in the same folder.
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const sep = process.platform === "win32" ? ";" : ":";
    const cur = env[key] ?? "";
    if (!cur.split(sep).includes(path.dirname(bin))) env[key] = cur ? `${cur}${sep}${path.dirname(bin)}` : path.dirname(bin);
  }
  return env;
}

/** cmd.exe quoting for the fixed arguments: an empty one or one with a space is quoted. */
function cmdArg(a: string): string {
  return a === "" || /[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

function runStep(cli: SubscriptionCli, bin: string, step: LiveCheckStep): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    // Windows: through cmd.exe, so an npm `.cmd` shim and a bare name on PATH both resolve.
    const command = win ? "cmd.exe" : bin;
    const args = win ? ["/d", "/s", "/c", `"${[bin === cli ? bin : `"${bin}"`, ...step.args.map(cmdArg)].join(" ")}"`] : step.args;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: tmpdir(),
        env: childEnv(cli, bin),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(win ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: (err as NodeJS.ErrnoException).code ?? "spawn_failed" });
      return;
    }
    // The deadline settles on its own: on Windows killing cmd.exe may leave
    // the CLI holding the pipes, so `close` is not waited for.
    collectLiveCheckChild(child as unknown as LiveCheckChild, step.timeoutMs, MAX_OUTPUT).then(resolve);
  });
}

async function checkNow(cli: SubscriptionCli): Promise<LiveCheck> {
  const status = detectSubscriptionCli(cli);
  if (!status.installed) return { cli, state: "missing", via: "none", fix: null, checkedAt: Date.now() };
  const bin = loginBinary(cli, status.binPath);
  return runLiveCheck(cli, (step) => runStep(cli, bin, step));
}

export function wireSubscriptionLiveCheckIpc(): void {
  const cache = new LiveCheckCache(checkNow);
  ipcMain.handle("cli:subscriptionLiveCheck", async (_event, payload: unknown) => {
    const { cli, force } = (payload ?? {}) as { cli?: unknown; force?: unknown };
    if (!isSubscriptionCli(cli)) return { ok: false, error: "cli must be claude or codex" };
    try {
      return { ok: true, check: await cache.get(cli, force === true) };
    } catch {
      return { ok: false, error: "the check could not run" };
    }
  });
}
