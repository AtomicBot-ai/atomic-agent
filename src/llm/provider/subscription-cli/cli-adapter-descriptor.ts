import type { SubscriptionCliName } from "../../../config/llm-config.js";
import type { CompletionResult } from "../completion-types.js";

/** Everything the argv builders need from one completion request. */
export interface CliArgsInput {
  model: string;
  systemPrompt: string;
  /** JSON Schema from `CompletionRequest.responseFormat`, when set. */
  responseSchema?: Record<string, unknown>;
  maxBudgetUsd?: number;
  extraArgs: readonly string[];
}

/** One parsed line of a streaming CLI's NDJSON output. */
export type CliStreamEvent =
  | { kind: "delta"; text: string }
  /** Terminal envelope — the same payload the buffered path parses. */
  | { kind: "final"; raw: string }
  /** Something worth logging but not worth failing on (rate-limit warnings). */
  | { kind: "notice"; message: string }
  | { kind: "ignore" };

/**
 * Everything that differs between one vendor CLI and another. The
 * provider class holds no CLI-specific knowledge, so adding a CLI is a
 * new descriptor plus a `SUBSCRIPTION_CLIS` entry — and a vendor
 * changing its interface is an edit to one file.
 */
export interface CliAdapterDescriptor {
  readonly cli: SubscriptionCliName;
  readonly displayName: string;
  readonly defaultBinary: string;
  readonly defaultChatModel: string;
  /** Replaces the CLI's own system prompt for the duration of a turn. */
  readonly systemPrompt: string;
  readonly staticModels: readonly string[];
  readonly contextWindow: number;
  readonly supportsJsonSchema: boolean;
  /** `"none"` means `completeStream` must fall back to buffering. */
  readonly streamMode: "ndjson" | "none";
  readonly installHint: string;
  readonly authHint: string;
  completeArgs(input: CliArgsInput): string[];
  streamArgs(input: CliArgsInput): string[];
  healthArgs(): string[];
  parseResult(stdout: string, fallbackModel: string): CompletionResult;
  parseStreamEvent(line: string): CliStreamEvent;
}

const descriptors = new Map<SubscriptionCliName, CliAdapterDescriptor>();

export function registerCliAdapter(descriptor: CliAdapterDescriptor): void {
  descriptors.set(descriptor.cli, descriptor);
}

export function resolveCliAdapter(
  cli: SubscriptionCliName,
): CliAdapterDescriptor {
  const descriptor = descriptors.get(cli);
  if (!descriptor) {
    throw new Error(`unknown subscription cli "${cli}"`);
  }
  return descriptor;
}
