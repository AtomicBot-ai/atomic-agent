import type { AgentAdapter, GaiaAgentRunContext, GaiaAgentRawRun } from "../harness/agent-adapter.js";
import { resolveOnPath, spawnCli } from "./spawn-cli.js";

const DEFAULT_CLI = "hermes";

/**
 * Hermes Agent (NousResearch) adapter.
 *
 * Real CLI (v0.16.x): `hermes chat -q "<prompt>" --yolo --max-turns N`.
 *   -q/--query    single non-interactive query
 *   --yolo        bypass dangerous-command approval prompts (headless runs)
 *   --max-turns   tool-calling iteration cap
 *
 * IMPORTANT — do NOT pass `-Q/--quiet`. On long multi-turn runs (many tool
 * calls) Hermes' quiet mode emits only the `session_id:` banner and drops the
 * final assistant message from stdout, so correct answers were captured as
 * empty and scored wrong. Verbose mode reliably prints the final answer (inside
 * a box-drawing panel), which `cleanHermesOutput` below strips back to the bare
 * `FINAL ANSWER: <value>` line for the GAIA extractor.
 *   --ignore-rules  skip auto-injection of AGENTS.md / memory / preloaded
 *                   skills so each GAIA case is stateless (no cross-case memory
 *                   contamination). NOTE: this also disables Hermes' preloaded
 *                   skill bodies — flip ATOMIC_AGENT_HERMES_STATELESS=0 to run
 *                   "fully stock" Hermes with its global memory + skills.
 *
 * The local llama-server endpoint is NOT passed on the CLI (Hermes has no
 * --base-url flag and ignores OPENAI_BASE_URL for the primary turn provider).
 * It is read from ~/.hermes/config.yaml: set `model.provider: custom`,
 * `model.base_url: <chat url>/v1`, `model.api_key: local`. See eval-agents
 * README "Competitors" for the one-time setup.
 *
 * Because the installer wires `hermes` only into the interactive shell rc
 * (not the `sh -c` PATH the harness uses), point HERMES_CLI at the absolute
 * binary: `HERMES_CLI=$HOME/.hermes/hermes-agent/hermes`.
 */
export function createHermesAdapter(): AgentAdapter {
  return {
    id: "hermes",
    label: "Hermes Agent (NousResearch)",
    probeRequirements() {
      const cli = process.env.HERMES_CLI ?? DEFAULT_CLI;
      const bin = resolveOnPath(cli);
      if (!bin) {
        return [`${cli} not on PATH (set HERMES_CLI=$HOME/.hermes/hermes-agent/hermes)`];
      }
      return [];
    },
    async runQuestion(ctx: GaiaAgentRunContext): Promise<GaiaAgentRawRun> {
      const cli = process.env.HERMES_CLI ?? DEFAULT_CLI;
      const bin = resolveOnPath(cli);
      if (!bin) {
        throw new Error(`${cli} not on PATH`);
      }

      const stateless = process.env.ATOMIC_AGENT_HERMES_STATELESS !== "0";
      const model = process.env.HERMES_LLM_MODEL;

      const args = [
        "chat",
        "-q",
        ctx.prompt,
        "--yolo",
        "--max-turns",
        String(ctx.maxSteps),
        ...(stateless ? ["--ignore-rules"] : []),
        ...(model ? ["-m", model] : []),
      ];

      const spawn = await spawnCli({
        command: bin,
        args,
        cwd: ctx.workingDir,
        env: { ...process.env },
        timeoutMs: ctx.timeoutMs,
      });

      // Clean BOTH streams: when a run ends without a final answer, stdout is
      // empty and the stderr fallback would otherwise surface the bare
      // `session_id:` banner as the "answer". Strip it from both so a genuinely
      // answerless run is reported as an empty reply, not noise.
      const rawReply =
        cleanHermesOutput(spawn.stdout) || cleanHermesOutput(spawn.stderr);
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

// CSI / OSC ANSI escape sequences Hermes emits in verbose (non-quiet) mode.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007/g;
// Box-drawing + light-vertical-dotted glyphs framing the final-answer panel
// (╭ ╮ ╰ ╯ │ ─ ┊ …). Range U+2500–U+257F covers the box-drawing block.
const BOX_CHARS_RE = /[\u2500-\u257F]/g;

/**
 * Verbose Hermes output frames the final answer in a box-drawing panel and may
 * carry ANSI color codes; quiet mode trails a `session_id: <id>` banner. Strip
 * all of it so the GAIA extractor sees clean lines including the bare
 * `FINAL ANSWER: <value>` line.
 */
function cleanHermesOutput(raw: string): string {
  return raw
    .replace(ANSI_RE, "")
    .split("\n")
    .map((line) => line.replace(BOX_CHARS_RE, " ").replace(/\s+$/g, "").trimStart())
    .filter((line) => !/^session_id:\s/.test(line.trim()))
    .join("\n")
    .trim();
}
