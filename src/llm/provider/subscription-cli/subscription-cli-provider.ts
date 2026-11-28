import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { RateLimitWindow } from "../rate-limits.js";
import type { ToolCallAdapter } from "../adapters/tool-call-adapter.js";
import type { CliAdapterDescriptor } from "./cli-adapter-descriptor.js";
import { resolveCliBinary } from "./resolve-cli-binary.js";
import { offlineRefusalFor } from "../../offline-network.js";
import { runCliCommand, type CliRunner } from "./run-cli-completion.js";
import { noResultEnvelopeError } from "./cli-no-result-error.js";
import {
  checkCliVersionOnce,
  cliOutdatedMark,
  noteOutdatedCli,
  withCliOutdated,
  noteOutdatedOnThrow,
  type CliVersionCheck,
  type CliVersionVerdict,
} from "./cli-version-check.js";
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
  /**
   * ATO-1685: the once-per-process `--version` check before the first
   * turn. `false` turns it off. Defaults to the real check, except when
   * a test injects `runCliImpl` or `streamCliImpl`: then it is off unless
   * given, so no test spawns a real CLI.
   */
  versionCheck?: CliVersionCheck | false;
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
   * The tools are never forwarded to the CLI (no `tools` payload, no
   * MCP), so the transport it really serves is the text one: the prompt
   * asks for the JSON-array tool call and `parseToolCalls` reads it out
   * of `content`. It used to declare `native_tools` — which made the
   * persona say "never write tool-call JSON as text" to a model that
   * had no other way to call a tool, while Codex's steering text asked
   * for the JSON array. The price is that a format drift now takes the
   * parser's one-shot retry (a second CLI invocation) instead of the
   * native recovery ladder; the gain is a prompt that agrees with the
   * wire. See F32.
   */
  readonly toolCallAdapter: ToolCallAdapter | null = null;
  /** Streaming is owned end to end here; that seam consumes SSE bytes. */
  readonly streamConsumer = null;

  private readonly descriptor: CliAdapterDescriptor;
  private readonly binary: string;
  private readonly cwd: string;
  private readonly model: string;

  /** The CLI's model, when one is set (Codex may leave it empty). */
  get chatModelId(): string | undefined {
    return this.model.length > 0 ? this.model : undefined;
  }
  private readonly extraArgs: readonly string[];
  private readonly streamingEnabled: boolean;
  private readonly maxBudgetUsd: number | undefined;
  private readonly timeoutMs: number;
  private readonly onNotice: ((message: string) => void) | undefined;
  private readonly runCli: CliRunner;
  private readonly streamCli: CliStreamRunner;
  private readonly versionCheck: CliVersionCheck | null;
  private versionVerdict: Promise<CliVersionVerdict | null> | null = null;

  constructor(options: SubscriptionCliProviderOptions) {
    const descriptor = options.descriptor;
    this.id = options.id;
    this.descriptor = descriptor;
    this.name = descriptor.displayName;
    this.binary = resolveCliBinary(descriptor.defaultBinary, options.binPath);
    this.cwd = options.cwd;
    // May be empty: Codex under a ChatGPT login rejects explicit model
    // ids and resolves one itself, so the flag is then omitted.
    this.model = options.model ?? descriptor.defaultChatModel;
    this.extraArgs = options.extraArgs ?? [];
    this.streamingEnabled =
      descriptor.streamMode === "ndjson" && options.streaming !== false;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onNotice = options.onNotice;
    this.runCli = options.runCliImpl ?? runCliCommand;
    this.streamCli = options.streamCliImpl ?? streamCliCommand;
    const injected =
      options.runCliImpl !== undefined || options.streamCliImpl !== undefined;
    this.versionCheck =
      options.versionCheck === false
        ? null
        : (options.versionCheck ?? (injected ? null : checkCliVersionOnce));
    this.capabilities = {
      vision: false,
      visionSource: "config-disabled",
      toolTransport: "grammar",
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
    this.refuseWhenOffline();
    const verdict = await this.checkVersion();
    const staged = await this.stageSchema(request);
    try {
      const args = this.descriptor.completeArgs(
        this.argsInput(request, staged.path),
      );
      const outcome = await this.runCli(this.runOptions(args, request));
      // ATO-2523: a successful turn on an outdated CLI says so in the chat.
      return withCliOutdated(
        this.descriptor.parseResult(outcome.stdout, this.model),
        this.outdatedMark(verdict),
      );
    } catch (err) {
      throw noteOutdatedCli(err, verdict);
    } finally {
      await staged.cleanup();
    }
  }

  /**
   * Some CLIs take the structured-output schema inline on argv, others
   * only as a path. Writing that file is a side effect, so it lives here
   * rather than inside the argv builders, which stay pure and testable.
   */
  private async stageSchema(
    request: CompletionRequest,
  ): Promise<{ path?: string; cleanup: () => Promise<void> }> {
    const noop = { cleanup: async () => {} };
    if (this.descriptor.schemaDelivery !== "file" || !request.responseFormat) {
      return noop;
    }
    const dir = await mkdtemp(join(tmpdir(), "atomic-cli-schema-"));
    const path = join(dir, "schema.json");
    await writeFile(
      path,
      JSON.stringify(request.responseFormat.schema),
      "utf8",
    );
    return {
      path,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
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

    this.refuseWhenOffline();
    const verdict = await this.checkVersion();
    const args = this.descriptor.streamArgs(this.argsInput(request));
    // A failed run's message gets the outdated sentence in front (ATO-1685).
    const lines = noteOutdatedOnThrow(
      this.streamCli(this.runOptions(args, request)),
      verdict,
    );
    let final: string | null = null;
    let sawDelta = false;
    let rateLimits: readonly RateLimitWindow[] | undefined;

    for await (const line of lines) {
      const event = this.descriptor.parseStreamEvent(line);
      if (event.kind === "delta") {
        sawDelta = true;
        yield { delta: event.text, reasoningDelta: "", done: false };
      } else if (event.kind === "final") {
        final = event.raw;
      } else if (event.kind === "notice") {
        this.onNotice?.(event.message);
      } else if (event.kind === "rate_limit") {
        rateLimits = mergeWindows(rateLimits, event.windows);
        if (event.notice) this.onNotice?.(event.notice);
      }
    }

    if (final === null) {
      // A typed failure with a fixed kind and a next step (ATO-2522).
      throw noteOutdatedCli(noResultEnvelopeError(this.binary, this.descriptor.productName), verdict);
    }
    let parsed: CompletionResult;
    try {
      parsed = this.descriptor.parseResult(final, this.model);
    } catch (err) {
      throw noteOutdatedCli(err, verdict);
    }
    const result: CompletionResult = withCliOutdated(
      rateLimits === undefined
        ? parsed
        : { ...parsed, rateLimits: mergeWindows(parsed.rateLimits, rateLimits) },
      this.outdatedMark(verdict),
    );
    // Safety net for a stream schema we do not control: if no delta was
    // recognised, emit the authoritative text once so a mismatch
    // degrades to buffered behaviour instead of an empty turn.
    if (!sawDelta && result.content.length > 0) {
      yield { delta: result.content, reasoningDelta: "", done: false };
    }
    yield { delta: "", reasoningDelta: "", done: true };
    return result;
  }

  /**
   * ATO-1685: the CLI's version, read once per process and binary
   * (`checkCliVersionOnce`) and capped at a few seconds. An outdated CLI
   * is said once through `onNotice` and in front of a failed run's
   * message; it never fails a turn by itself.
   */
  private checkVersion(): Promise<CliVersionVerdict | null> {
    const check = this.versionCheck;
    if (check === null) return Promise.resolve(null);
    this.versionVerdict ??= check({
      cli: this.descriptor.cli,
      productName: this.descriptor.productName,
      binary: this.binary,
      cwd: this.cwd,
      run: this.runCli,
      installHint: this.descriptor.installHint,
      authHint: this.descriptor.authHint,
      stripEnv: this.descriptor.billingEnvKeys,
    }).then(
      (verdict) => {
        if (verdict.outdated && verdict.message) this.onNotice?.(verdict.message);
        return verdict;
      },
      () => null,
    );
    return this.versionVerdict;
  }

  /** ATO-2523: the completion's `cliOutdated` mark for this verdict, or null. */
  private outdatedMark(verdict: CliVersionVerdict | null): ReturnType<typeof cliOutdatedMark> {
    return cliOutdatedMark(verdict, this.descriptor.cli, this.descriptor.productName);
  }

  /**
   * ATO-1084: the CLI is a separate program that talks to its vendor's
   * cloud, which the agent's HTTP pool cannot see, so offline mode
   * refuses it before it is started.
   */
  private refuseWhenOffline(): void {
    const refused = offlineRefusalFor(
      `${this.descriptor.productName} cloud`,
      this.descriptor.productName,
    );
    if (refused) throw refused;
  }

  async describeImage(_request: VisionRequest): Promise<VisionResult> {
    throw new VisionUnsupportedError(this.id);
  }

  async health(): Promise<ProviderHealthResult> {
    const started = Date.now();
    try {
      this.refuseWhenOffline();
      await this.runCli({
        binary: this.binary,
        args: this.descriptor.healthArgs(),
        cwd: this.cwd,
        timeoutMs: HEALTH_TIMEOUT_MS,
        maxOutputBytes: MAX_HEALTH_BYTES,
        installHint: this.descriptor.installHint,
        authHint: this.descriptor.authHint,
        productName: this.descriptor.productName,
        stripEnv: this.descriptor.billingEnvKeys,
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

  private argsInput(request: CompletionRequest, schemaPath?: string) {
    const delivery = this.descriptor.schemaDelivery;
    return {
      model: this.model,
      systemPrompt: this.descriptor.systemPrompt,
      ...(request.responseFormat && delivery === "inline"
        ? { responseSchema: request.responseFormat.schema }
        : {}),
      ...(schemaPath ? { responseSchemaPath: schemaPath } : {}),
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
      input: this.descriptor.buildStdin(
        request.prompt,
        this.descriptor.systemPrompt,
      ),
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_COMPLETION_BYTES,
      installHint: this.descriptor.installHint,
      authHint: this.descriptor.authHint,
      productName: this.descriptor.productName,
      stripEnv: this.descriptor.billingEnvKeys,
      ...(request.signal ? { signal: request.signal } : {}),
    };
  }
}

/**
 * Newer readings replace older ones of the same window; a window the
 * newer batch does not mention keeps its last reading (the CLI reports
 * one window per `rate_limit_event`).
 */
function mergeWindows(
  older: readonly RateLimitWindow[] | undefined,
  newer: readonly RateLimitWindow[],
): readonly RateLimitWindow[] {
  if (!older || older.length === 0) return newer;
  const key = (w: RateLimitWindow) => `${w.scope}/${w.name}`;
  const fresh = new Set(newer.map(key));
  return [...older.filter((w) => !fresh.has(key(w))), ...newer];
}
