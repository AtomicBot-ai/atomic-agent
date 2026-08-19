import type { SubscriptionCliName } from "../../../config/llm-config.js";
import type { CompletionResult } from "../completion-types.js";

/** Everything the argv builders need from one completion request. */
export interface CliArgsInput {
  /**
   * Empty when the operator set no model and the CLI resolves one
   * itself — Codex under a ChatGPT login rejects every explicit id, so
   * the flag has to be omitted rather than guessed at.
   */
  model: string;
  systemPrompt: string;
  /** JSON Schema from `CompletionRequest.responseFormat`, when set. */
  responseSchema?: Record<string, unknown>;
  /** Path to that schema on disk, for CLIs that take a file. */
  responseSchemaPath?: string;
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
  /**
   * How the CLI accepts a structured-output schema: `claude` takes it
   * inline on argv, `codex` takes a path to a file on disk.
   */
  readonly schemaDelivery: "inline" | "file" | "none";
  /** `"none"` means `completeStream` must fall back to buffering. */
  readonly streamMode: "ndjson" | "none";
  readonly installHint: string;
  readonly authHint: string;
  /**
   * The text written to the child's stdin. Exists because only some
   * CLIs have a system-prompt flag; the rest must carry that steering
   * inside the prompt itself.
   */
  buildStdin(prompt: string, systemPrompt: string): string;
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
