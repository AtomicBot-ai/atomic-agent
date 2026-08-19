import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
} from "../completion-types.js";
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderHealthResult,
  VisionRequest,
  VisionResult,
} from "../llm-provider.js";
import { VisionUnsupportedError } from "../llm-provider.js";
import type { ToolCallAdapter } from "../adapters/tool-call-adapter.js";
import { openAiToolCallAdapter } from "../openai/openai-tool-call-adapter.js";
import type { CliAdapterDescriptor } from "./cli-adapter-descriptor.js";
import { resolveCliBinary } from "./resolve-cli-binary.js";
import { runCliCommand, type CliRunner } from "./run-cli-completion.js";
import {
  streamCliCommand,
  type CliStreamRunner,
} from "./stream-cli-completion.js";

/** Matches `OpenAiProvider`'s default; a CLI turn is never quick. */
const DEFAULT_TIMEOUT_MS = 600_000;
/**
 * `runCommand` defaults to 256 KiB, which would silently truncate a long
 * completion and hand `JSON.parse` a torn object.
 */
const MAX_COMPLETION_BYTES = 8 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_HEALTH_BYTES = 64 * 1024;

export interface SubscriptionCliProviderOptions {
  id: string;
  descriptor: CliAdapterDescriptor;
  /** Working directory for the child — the state dir, not the agent's cwd. */
  cwd: string;
  model?: string;
  binPath?: string;
  extraArgs?: readonly string[];
  streaming?: boolean;
  maxBudgetUsd?: number;
  requestTimeoutMs?: number;
  onNotice?: (message: string) => void;
  /** Test seams; default to the real spawn-backed implementations. */
  runCliImpl?: CliRunner;
  streamCliImpl?: CliStreamRunner;
}

/**
 * Drives an already-signed-in vendor CLI (`claude`, `codex`) as an LLM
 * backend so a flat-rate subscription can power the agent with no API
 * key. The CLI authenticates from its own session — this provider never
 * reads, copies or replays OAuth tokens or keychain entries.
 *
 * Every CLI-specific decision lives in the descriptor; this class only
 * knows how to run a process and shape the result.
 */
export class SubscriptionCliProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * We never return `tool_calls`, yet the transport is `native_tools`
   * and the adapter is present on purpose. On the grammar transport a
   * format drift throws out of `parseToolCalls` and costs a second full
   * CLI invocation on the repair path; on the native transport an empty
   * `toolCalls` sends step-executor down its guarded recovery ladder,
   * which parses the tool-call JSON out of `content` inside a
   * try/catch and otherwise wraps the prose as a `reply`. Same result
   * when the model complies, no extra process when it does not.
   */
  readonly toolCallAdapter: ToolCallAdapter = openAiToolCallAdapter;
  /** Streaming is owned end to end here; that seam consumes SSE bytes. */
  readonly streamConsumer = null;

  private readonly descriptor: CliAdapterDescriptor;
  private readonly binary: string;
  private readonly cwd: string;
  private readonly model: string;
  private readonly extraArgs: readonly string[];
  private readonly streamingEnabled: boolean;
  private readonly maxBudgetUsd: number | undefined;
  private readonly timeoutMs: number;
  private readonly onNotice: ((message: string) => void) | undefined;
  private readonly runCli: CliRunner;
  private readonly streamCli: CliStreamRunner;

  constructor(options: SubscriptionCliProviderOptions) {
    const descriptor = options.descriptor;
    this.id = options.id;
    this.descriptor = descriptor;
    this.name = descriptor.displayName;
    this.binary = resolveCliBinary(descriptor.defaultBinary, options.binPath);
    this.cwd = options.cwd;
    this.model = options.model ?? descriptor.defaultChatModel;
    this.extraArgs = options.extraArgs ?? [];
    this.streamingEnabled =
      descriptor.streamMode === "ndjson" && options.streaming !== false;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onNotice = options.onNotice;
    this.runCli = options.runCliImpl ?? runCliCommand;
    this.streamCli = options.streamCliImpl ?? streamCliCommand;
    this.capabilities = {
      vision: false,
      visionSource: "config-disabled",
      toolTransport: "native_tools",
      contextWindow: descriptor.contextWindow,
      supportsParallelTools: false,
      // Every completion is a fresh process; there is no slot to pin.
      supportsSlotAffinity: false,
      // Verified: server-side prompt caching survives across separate
      // invocations, so the KV-stable two-zone prompt still pays off.
      supportsPromptCache: true,
      reasoningFormat: "none",
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const args = this.descriptor.completeArgs(this.argsInput(request));
    const outcome = await this.runCli(this.runOptions(args, request));
    return this.descriptor.parseResult(outcome.stdout, this.model);
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    if (!this.streamingEnabled) {
      const result = await this.complete(request);
      if (result.content.length > 0) {
        yield { delta: result.content, reasoningDelta: "", done: false };
      }
      yield { delta: "", reasoningDelta: "", done: true };
      return result;
    }

    const args = this.descriptor.streamArgs(this.argsInput(request));
    const lines = this.streamCli(this.runOptions(args, request));
    let final: string | null = null;
    let sawDelta = false;

    for await (const line of lines) {
      const event = this.descriptor.parseStreamEvent(line);
      if (event.kind === "delta") {
        sawDelta = true;
        yield { delta: event.text, reasoningDelta: "", done: false };
      } else if (event.kind === "final") {
        final = event.raw;
      } else if (event.kind === "notice") {
        this.onNotice?.(event.message);
      }
    }

    if (final === null) {
      throw new Error(
        `${this.binary} stream ended without a result envelope`,
      );
    }
    const result = this.descriptor.parseResult(final, this.model);
    // Safety net for a stream schema we do not control: if no delta was
    // recognised, emit the authoritative text once so a mismatch
    // degrades to buffered behaviour instead of an empty turn.
    if (!sawDelta && result.content.length > 0) {
      yield { delta: result.content, reasoningDelta: "", done: false };
    }
    yield { delta: "", reasoningDelta: "", done: true };
    return result;
  }

  async describeImage(_request: VisionRequest): Promise<VisionResult> {
    throw new VisionUnsupportedError(this.id);
  }

  async health(): Promise<ProviderHealthResult> {
    const started = Date.now();
    try {
      await this.runCli({
        binary: this.binary,
        args: this.descriptor.healthArgs(),
        cwd: this.cwd,
        timeoutMs: HEALTH_TIMEOUT_MS,
        maxOutputBytes: MAX_HEALTH_BYTES,
        installHint: this.descriptor.installHint,
        authHint: this.descriptor.authHint,
      });
      return {
        reachable: true,
        status: null,
        error: null,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  async listModels(): Promise<readonly string[]> {
    // Curated list, no probe: the CLI exposes no model-list command.
    return this.descriptor.staticModels;
  }

  async close(): Promise<void> {
    // Nothing to release — every invocation is its own short-lived process.
  }

  private argsInput(request: CompletionRequest) {
    return {
      model: this.model,
      systemPrompt: this.descriptor.systemPrompt,
      ...(request.responseFormat
        ? { responseSchema: request.responseFormat.schema }
        : {}),
      ...(this.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: this.maxBudgetUsd }),
      extraArgs: this.extraArgs,
    };
  }

  private runOptions(args: readonly string[], request: CompletionRequest) {
    return {
      binary: this.binary,
      args,
      // The prompt goes on stdin, never argv: a two-zone prompt routinely
      // exceeds the 128 KiB single-argument limit once the conversation
      // zone fills, and argv delivery would fail with E2BIG on exactly
      // the long sessions that matter most.
      input: request.prompt,
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_COMPLETION_BYTES,
      installHint: this.descriptor.installHint,
      authHint: this.descriptor.authHint,
      ...(request.signal ? { signal: request.signal } : {}),
    };
  }
}
