import { spawn, spawnSync } from "node:child_process";

export interface SpawnCliOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
}

export interface SpawnCliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function spawnCli(opts: SpawnCliOptions): Promise<SpawnCliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const startedAt = Date.now();
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      rejectResult(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolveResult({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** Returns absolute path when `bin` is on PATH, else null. */
export function resolveOnPath(bin: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${shellQuote(bin)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = (r.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
