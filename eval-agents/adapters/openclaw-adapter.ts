import type { AgentAdapter, GaiaAgentRunContext, GaiaAgentRawRun } from "../harness/agent-adapter.js";
import { resolveOnPath, spawnCli } from "./spawn-cli.js";

const DEFAULT_CLI = "openclaw";

export function createOpenclawAdapter(): AgentAdapter {
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

      const spawn = await spawnCli({
        command: bin,
        args: [
          "agent",
          "--message",
          ctx.prompt,
          "--thinking",
          "low",
        ],
        cwd: ctx.workingDir,
        env: {
          ...process.env,
          OPENCLAW_WORKSPACE: ctx.workingDir,
          OPENCLAW_LLM_BASE_URL: baseUrl,
        },
        timeoutMs: ctx.timeoutMs,
      });

      const rawReply = spawn.stdout.trim() || spawn.stderr.trim();
      return {
        rawReply,
        exitCode: spawn.exitCode,
        timedOut: spawn.timedOut,
        error: spawn.timedOut ? "timeout" : spawn.exitCode !== 0 ? spawn.stderr.slice(0, 500) : null,
        metrics: {
          stepCount: null,
          promptTokens: null,
          predictedTokens: null,
          toolErrors: null,
          wallClockMs: spawn.durationMs,
          timedOut: spawn.timedOut,
          exitCode: spawn.exitCode,
        },
      };
    },
  };
}
