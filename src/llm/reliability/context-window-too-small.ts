import { LlmFailure } from "./llm-failures.js";

/**
 * The fixed part of a local prompt (instructions plus the native tool
 * schemas) leaves no room for even a short reply in the model's context
 * window, so the step is not sent (ATO-1678).
 *
 * With many tools and MCP servers on a `native_tools` link the `tools`
 * array alone can take half of a 32k window. Sending such a request
 * anyway only ends in a reply cut after a few tokens (`context_full`),
 * every time, and the person cannot tell why. The step fails before the
 * request instead, with the two ways out: a bigger context window, or
 * fewer tools and MCP servers. Like LM Studio's and Ollama's "context
 * too small" guidance, the fix is the person's, so error reporting does
 * not report it (matched by name in `error-reporter.ts`).
 *
 * Category `grammar`, as `RequestTooLargeError`: the same request is
 * refused the same way on a retry, so no fallover and no blind retry.
 */
export class ContextWindowTooSmallError extends LlmFailure {
  readonly category = "grammar" as const;

  constructor(
    /** The model's context window, in tokens. */
    readonly contextWindow: number,
    /** Estimated tokens of everything in the prompt but the transcript. */
    readonly fixedTokens: number,
    /** Of those, the native tool schemas (`0` on the grammar transport). */
    readonly toolSchemaTokens: number,
  ) {
    super(contextWindowTooSmallMessage(contextWindow, fixedTokens, toolSchemaTokens));
    this.name = "ContextWindowTooSmallError";
  }
}

export function isContextWindowTooSmall(
  err: unknown,
): err is ContextWindowTooSmallError {
  return err instanceof ContextWindowTooSmallError;
}

function contextWindowTooSmallMessage(
  contextWindow: number,
  fixedTokens: number,
  toolSchemaTokens: number,
): string {
  const tools =
    toolSchemaTokens > 0
      ? ` The tool descriptions alone take about ${toolSchemaTokens} tokens.`
      : "";
  return (
    `This model's context window (${contextWindow} tokens) is too small for the agent's instructions and turned-on tools, ` +
    `which take about ${fixedTokens} tokens and leave no room for a reply.${tools} ` +
    "Load the model with a bigger context, or turn off some tools or MCP servers, then try again."
  );
}
