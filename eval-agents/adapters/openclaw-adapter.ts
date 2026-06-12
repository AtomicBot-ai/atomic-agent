import type { AgentAdapter, GaiaAgentRunContext, GaiaAgentRawRun } from "../harness/agent-adapter.js";
import { resolveOnPath, spawnCli } from "./spawn-cli.js";

const DEFAULT_CLI = "openclaw";

interface OpenclawJsonResult {
  reply: string;
  promptTokens: number | null;
  predictedTokens: number | null;
}

/**
 * Parse the `openclaw agent --json` envelope. The visible assistant reply lives
 * in `payloads[].text`; `meta.finalAssistantVisibleText` is the fallback. Token
 * usage (when present) comes from `meta.agentMeta.usage`. On any parse failure we
 * fall back to the raw stdout so a malformed envelope still surfaces something.
 */
function parseOpenclawJson(stdout: string): OpenclawJsonResult {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return { reply: trimmed, promptTokens: null, predictedTokens: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    return { reply: trimmed, promptTokens: null, predictedTokens: null };
  }
  const obj = parsed as {
    payloads?: { text?: string | null }[];
    meta?: {
      finalAssistantVisibleText?: string | null;
      finalAssistantRawText?: string | null;
      agentMeta?: { usage?: { input?: number; output?: number } };
    };
  };
  const fromPayloads = (obj.payloads ?? [])
    .map((p) => (typeof p.text === "string" ? p.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
  const reply =
    fromPayloads
    || obj.meta?.finalAssistantVisibleText?.trim()
    || obj.meta?.finalAssistantRawText?.trim()
    || "";
  const usage = obj.meta?.agentMeta?.usage;
  return {
    reply,
    promptTokens: typeof usage?.input === "number" ? usage.input : null,
    predictedTokens: typeof usage?.output === "number" ? usage.output : null,
  };
}

export function createOpenclawAdapter(): AgentAdapter {
  // Per-run nonce so session ids are unique across runs. OpenClaw persists each
  // session to ~/.openclaw/agents/main/sessions/<id>.jsonl; reusing a plain
  // `gaia-<taskId>` id across runs resumes the stale session and the embedded
  // agent returns an empty payload. A fresh id per (run, task) avoids that.
  const runNonce = Date.now().toString(36);
  return {
    id: "openclaw",
    label: "OpenClaw",
    probeRequirements() {
      const cli = process.env.OPENCLAW_CLI ?? DEFAULT_CLI;
      const bin = resolveOnPath(cli);
      if (!bin) return [`${cli} not on PATH`];
      const base = process.env.OPENCLAW_LLM_BASE_URL ?? process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
      if (!base) return ["OPENCLAW_LLM_BASE_URL or ATOMIC_AGENT_EVAL_LLAMA_URL"];
      return [];
    },
    async runQuestion(ctx: GaiaAgentRunContext): Promise<GaiaAgentRawRun> {
      const cli = process.env.OPENCLAW_CLI ?? DEFAULT_CLI;
      const bin = resolveOnPath(cli);
      if (!bin) {
        throw new Error(`${cli} not on PATH`);
      }

      const baseUrl = (
        process.env.OPENCLAW_LLM_BASE_URL
        ?? process.env.ATOMIC_AGENT_EVAL_LLAMA_URL
        ?? ctx.chatUrl
      ).replace(/\/$/, "");

      // Run the embedded agent (`--local`) so no Gateway daemon is required.
      // The custom OpenAI-compatible provider pointing at the local llama-server
      // is configured in ~/.openclaw/openclaw.json. A unique per-task session id
      // isolates each question from the others.
      const sessionId = `gaia-${runNonce}-${ctx.row.task_id}`;
      const agentTimeoutSec = Math.max(60, Math.floor(ctx.timeoutMs / 1000) - 30);

      // The harness runs adapters inside a vitest worker, which sets VITEST=true.
      // OpenClaw detects that and suppresses ALL stdout (even with --json),
      // producing an empty reply. Strip every VITEST* var from the child env so
      // OpenClaw behaves like a normal CLI invocation.
      const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_LLM_BASE_URL: baseUrl };
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith("VITEST")) delete childEnv[key];
      }

      // `--json` is required: without it the embedded agent delivers its reply to
      // a channel and prints nothing useful to stdout. The reply text is parsed
      // from the JSON envelope (`payloads[].text`). The agent uses the global
      // `~/.openclaw/workspace` for identity — `openclaw agent` ignores
      // OPENCLAW_WORKSPACE — so per-task workspace seeding is not attempted here.
      const spawn = await spawnCli({
        command: bin,
        args: [
          "agent",
          "--local",
          "--json",
          "--session-id",
          sessionId,
          "--thinking",
          "low",
          "--timeout",
          String(agentTimeoutSec),
          "--message",
          ctx.prompt,
        ],
        cwd: ctx.workingDir,
        env: childEnv,
        timeoutMs: ctx.timeoutMs,
      });

      const parsed = parseOpenclawJson(spawn.stdout);
      const rawReply = parsed.reply || spawn.stderr.trim();
      return {
        rawReply,
        exitCode: spawn.exitCode,
        timedOut: spawn.timedOut,
        error: spawn.timedOut ? "timeout" : spawn.exitCode !== 0 ? spawn.stderr.slice(0, 500) : null,
        metrics: {
          stepCount: null,
          promptTokens: parsed.promptTokens,
          predictedTokens: parsed.predictedTokens,
          toolErrors: null,
          wallClockMs: spawn.durationMs,
          timedOut: spawn.timedOut,
          exitCode: spawn.exitCode,
        },
      };
    },
  };
}
