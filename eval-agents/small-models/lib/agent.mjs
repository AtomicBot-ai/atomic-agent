// Drives `atomic-agent run` headless for one bench run: fresh state dir,
// seeded config pointing at an external llama-server, one or more user turns.
//
// Multi-turn: `run` reads stdin with readline and drops lines that arrive
// before it asks, so we send turn N+1 only after turn N's reply line shows up
// on stdout (same rule as eval-memory/harness/multi-turn-driver.ts).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * `--agent` accepts either a checkout (we run `<checkout>/dist/cli/index.js`
 * with this Node) or an executable (an installed `atomic-agent` binary).
 * Returns { cmd, args, label } or throws with a plain-language reason.
 */
export function resolveAgentCommand(agentPath) {
  if (!agentPath) throw new Error("--agent <checkout or binary> is required");
  const p = resolve(agentPath);
  if (!existsSync(p)) throw new Error(`--agent path does not exist: ${p}`);
  if (statSync(p).isDirectory()) {
    const cli = join(p, "dist", "cli", "index.js");
    if (!existsSync(cli)) throw new Error(`${cli} is missing: run \`npm run build\` in that checkout first`);
    if (!existsSync(join(p, "grammars"))) throw new Error(`${join(p, "grammars")} is missing (the agent needs it next to dist/)`);
    return { cmd: process.execPath, args: [cli], label: "checkout", root: p };
  }
  return { cmd: p, args: [], label: "binary", root: null };
}

/**
 * Minimal config for a headless bench run. Everything not listed keeps the
 * product default on purpose: the bench measures what users get.
 * Unknown keys are dropped by the config normaliser, so only real keys here.
 */
export function buildAgentConfig({ serverUrl, thinking, maxSteps, overrides = {} }) {
  const base = {
    localModels: {
      mode: "external",
      url: serverUrl.replace(/\/v1\/?$/, ""),
      ...(thinking === "on" || thinking === "off" ? { thinking } : {}),
    },
    analytics: { enabled: false },
    agent: { approvalLevel: 5, maxSteps },
    tracing: { trace: { enabled: true } },
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v;
  }
  return out;
}

export function seedStateDir(stateDir, config) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Env for the child: isolated state, analytics off, long llama timeout for slow 27B steps. */
export function agentEnv(stateDir, extra = {}) {
  const env = { ...process.env };
  // Never inherit a developer's real state dir or llama URL overrides.
  delete env.ATOMIC_AGENT_EVAL_LLAMA_URL;
  return {
    ...env,
    ATOMIC_AGENT_STATE_DIR: stateDir,
    ATOMIC_AGENT_ANALYTICS: "off",
    ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS: process.env.ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS ?? "1800000",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    PYTHONDONTWRITEBYTECODE: "",
    ...extra,
  };
}

/** The CLI takes one line per turn; collapse newlines so a prompt is one turn. */
export function oneLine(prompt) {
  return prompt.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Spawn the agent and feed `turns` one at a time.
 * Resolves { exitCode, signal, timedOut, durationMs, stdout, stderr, turnsSent, replies }.
 */
export function runAgent({ command, workDir, stateDir, turns, maxSteps, timeoutMs, env }) {
  return new Promise((resolveRun, rejectRun) => {
    const started = Date.now();
    const child = spawn(
      command.cmd,
      [...command.args, "run", "--cwd", workDir, "--no-approval", "--max-steps", String(maxSteps)],
      { cwd: workDir, env: env ?? agentEnv(stateDir), stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    let stdout = "";
    let stderr = "";
    let pending = "";
    let replies = 0;
    let turnsSent = 0;
    let timedOut = false;

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 3000).unref();
    }, timeoutMs);

    const sendNext = () => {
      if (turnsSent < turns.length) {
        child.stdin.write(`${oneLine(turns[turnsSent])}\n`);
        turnsSent += 1;
      } else {
        child.stdin.end();
      }
    };

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stdout += s;
      pending += s;
      let idx;
      while ((idx = pending.indexOf("\n")) >= 0) {
        pending = pending.slice(idx + 1);
        replies += 1;
        sendNext();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
      /* agent exited early (e.g. called finish); reported via turnsSent < turns */
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, signal, timedOut, durationMs: Date.now() - started, stdout, stderr, turnsSent, replies });
    });
    sendNext();
  });
}
