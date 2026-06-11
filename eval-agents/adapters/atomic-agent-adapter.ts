import { join } from "node:path";

import { spawnAgentRun } from "../../eval/harness/spawn-agent.js";
import { parseCliOutput } from "../../eval/harness/parse-cli-output.js";
import { collectTraceMetrics } from "../../eval/harness/parse-trace-metrics.js";
import { seedConfigJson } from "../../eval-memory/harness/memory-profiles.js";

import type { AgentAdapter, GaiaAgentRunContext, GaiaAgentRawRun } from "../harness/agent-adapter.js";

export function createAtomicAgentAdapter(): AgentAdapter {
  return {
    id: "atomic-agent",
    label: "atomic-agent (memory fabric on)",
    probeRequirements() {
      const missing: string[] = [];
      if (!process.env.ATOMIC_AGENT_EVAL_LLAMA_URL) {
        missing.push("ATOMIC_AGENT_EVAL_LLAMA_URL (or managed daemon via orchestrator)");
      }
      return missing;
    },
    async runQuestion(ctx: GaiaAgentRunContext): Promise<GaiaAgentRawRun> {
      seedConfigJson(ctx.stateDir, "on", {
        llamaUrl: ctx.chatUrl,
        maxSteps: ctx.maxSteps,
        embeddings: { enabled: ctx.embedUrl !== null },
      });

      const spawn = await spawnAgentRun({
        workingDir: ctx.workingDir,
        stateDir: ctx.stateDir,
        prompt: ctx.prompt,
        maxSteps: ctx.maxSteps,
        timeoutMs: ctx.timeoutMs,
        // Benchmark the npm-run-build output, never the source tree or the
        // PATH-installed release binary.
        requireDist: true,
      });

      const cli = parseCliOutput(spawn.stdout, spawn.stderr);
      let stepCount: number | null = cli.stepCount;
      let promptTokens: number | null = null;
      let predictedTokens: number | null = null;
      let toolErrors: number | null = null;

      if (cli.sessionId) {
        const tracePath = join(ctx.stateDir, "traces", `${cli.sessionId}.ndjson`);
        const metrics = await collectTraceMetrics(tracePath);
        stepCount = metrics.stepCount;
        promptTokens = metrics.totalPromptTokens;
        predictedTokens = metrics.totalPredictedTokens;
        toolErrors = metrics.toolErrorCount;
      }

      return {
        rawReply: cli.reply,
        exitCode: spawn.exitCode,
        timedOut: spawn.timedOut,
        error: cli.lastError ?? (spawn.timedOut ? "timeout" : null),
        metrics: {
          stepCount,
          promptTokens,
          predictedTokens,
          toolErrors,
          wallClockMs: spawn.durationMs,
          timedOut: spawn.timedOut,
          exitCode: spawn.exitCode,
        },
      };
    },
  };
}
