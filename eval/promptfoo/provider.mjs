// promptfoo custom provider: one test = one real `atomic-agent run` in a
// fresh temp project and state dir, exactly like eval/harness/spawn-agent.ts.
//
//   providers:
//     - id: file://provider.mjs
//       config: { output: json }   # json (default) | reply
//
// Test vars it reads:
//   task     the user message (the prompt template is "{{task}}")
//   files    { "rel/path": "body" } seeded into the project before the run
//   maxSteps optional per-test step cap (default 15)
//
// With `output: json` the result is a JSON string
//   { reply, exitCode, timedOut, tools: [{ tool, status, args }], files }
// for the deterministic checks in asserts.mjs. `output: reply` returns the
// bare reply, which is what the red-team grader should read.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPO_ROOT,
  buildStateConfig,
  resolveTarget,
  seedFiles,
  sessionIdFromStderr,
  snapshotFiles,
  toolCallsFromTrace,
} from "./workspace.mjs";

const DIST_CLI = join(REPO_ROOT, "dist", "cli", "index.js");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SRC_CLI = join(REPO_ROOT, "src", "cli", "index.ts");

function cliCommand() {
  if (existsSync(DIST_CLI)) return { command: process.execPath, args: [DIST_CLI] };
  if (existsSync(TSX_BIN)) return { command: TSX_BIN, args: [SRC_CLI] };
  return null;
}

function runAgent({ workingDir, stateDir, task, maxSteps, timeoutMs, noApproval }) {
  const cli = cliCommand();
  if (!cli) {
    return Promise.reject(new Error("no agent CLI: run `npm run build` (or `npm ci` for tsx) first"));
  }
  const args = [...cli.args, "run", "--cwd", workingDir, "--max-steps", String(maxSteps)];
  if (noApproval) args.push("--no-approval");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cli.command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ATOMIC_AGENT_STATE_DIR: stateDir,
        DO_NOT_TRACK: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); rejectRun(err); });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveRun({ exitCode, stdout, stderr, timedOut });
    });
    child.stdin.write(`${task}\n`);
    child.stdin.end();
  });
}

export default class AtomicAgentProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.label = options.label ?? "atomic-agent";
  }

  id() {
    return "atomic-agent-run";
  }

  async callApi(prompt, context) {
    const target = resolveTarget();
    if (!target) {
      return { error: "set PROMPTFOO_AGENT_LLAMA_URL or OPENROUTER_API_KEY for the agent under test" };
    }
    const vars = context?.vars ?? {};
    const task = typeof vars.task === "string" && vars.task.length > 0 ? vars.task : prompt;
    const root = mkdtempSync(join(tmpdir(), "aa-promptfoo-"));
    const workingDir = join(root, "project");
    const stateDir = join(root, "state");
    try {
      seedFiles(workingDir, typeof vars.files === "object" ? vars.files : {});
      seedFiles(stateDir, {});
      writeFileSync(join(stateDir, "config.json"), JSON.stringify(buildStateConfig(target), null, 2));
      const run = await runAgent({
        workingDir,
        stateDir,
        task,
        maxSteps: Number(vars.maxSteps ?? this.config.maxSteps ?? 15),
        timeoutMs: Number(process.env.PROMPTFOO_AGENT_TIMEOUT_MS ?? this.config.timeoutMs ?? 300_000),
        noApproval: this.config.noApproval !== false,
      });
      const sessionId = sessionIdFromStderr(run.stderr);
      const tracePath = sessionId ? join(stateDir, "traces", `${sessionId}.ndjson`) : null;
      const reply = run.stdout.trim();
      if (this.config.output === "reply") {
        return run.timedOut ? { error: "agent run timed out", output: reply } : { output: reply };
      }
      const result = {
        reply,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        tools: toolCallsFromTrace(tracePath),
        files: snapshotFiles(workingDir),
      };
      return { output: JSON.stringify(result) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
