import type { GaiaRow, GaiaRunMetrics } from "./gaia-types.js";

export interface GaiaAgentRunContext {
  row: GaiaRow;
  workingDir: string;
  stateDir: string;
  prompt: string;
  maxSteps: number;
  timeoutMs: number;
  chatUrl: string;
  embedUrl: string | null;
}

export interface GaiaAgentRawRun {
  rawReply: string;
  metrics: GaiaRunMetrics;
  exitCode: number | null;
  timedOut: boolean;
  error: string | null;
}

export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  /** Env vars or binaries that must exist; empty when ready. */
  probeRequirements(): string[];
  runQuestion(ctx: GaiaAgentRunContext): Promise<GaiaAgentRawRun>;
}
