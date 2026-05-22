/**
 * MCP sampling handler.
 *
 * MCP servers can request the **client's** LLM to generate text on
 * their behalf via `sampling/createMessage`. atomic-agent forwards
 * those requests to the same `LlamaServerClient` that drives the
 * agent loop — but always on `slotId: -1` so the request never
 * collides with the main agent slot or the reflection slot.
 *
 * Locked invariants (AGENTS.md §"MCP client"):
 *   1. Sampling **always** uses `slotId: -1`. The main agent slot
 *      and the reflection slot are off-limits to MCP traffic.
 *   2. The handler is fire-safe — every error is folded into a
 *      thrown `Error` that the SDK converts into a JSON-RPC error
 *      sent back to the server. We never crash the client transport.
 *   3. No grammar is attached. MCP sampling is free-form text; the
 *      MCP server is responsible for any structure it expects.
 */

import type { LlamaServerClient } from "../llm/llama-server-client.js";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpSamplingHandler } from "./mcp-client.js";

const DEFAULT_MAX_TOKENS = 512;

export interface CreateMcpSamplingHandlerDeps {
  llamaServerClient: LlamaServerClient;
  /** Per-server name — used only for tagging when we have a structured log surface. */
  server: string;
}

/**
 * Build a `McpSamplingHandler` bound to the given LLM client. The
 * returned function is what `McpClient` installs as the request
 * handler for `sampling/createMessage`.
 */
export function createMcpSamplingHandler(
  deps: CreateMcpSamplingHandlerDeps,
): McpSamplingHandler {
  return async (
    params: CreateMessageRequest["params"],
    signal: AbortSignal,
  ): Promise<CreateMessageResult> => {
    const prompt = flattenMessagesToPrompt(params.messages, params.systemPrompt);
    const maxTokens =
      typeof params.maxTokens === "number" && params.maxTokens > 0
        ? Math.min(params.maxTokens, 4_096)
        : DEFAULT_MAX_TOKENS;
    const temperature =
      typeof params.temperature === "number" ? params.temperature : 0.7;

    if (signal.aborted) {
      throw new Error("aborted");
    }

    const result = await deps.llamaServerClient.complete({
      prompt,
      // INVARIANT 1: -1 means "no slot reuse". Never the main agent
      // slot, never the reflection slot. See AGENTS.md.
      slotId: -1,
      cachePrompt: false,
      maxTokens,
      temperature,
      stop: ["\nuser:", "\nUSER:"],
    });

    return {
      role: "assistant",
      model: result.modelId ?? "llama-server",
      stopReason: result.stop ? "endTurn" : "maxTokens",
      content: {
        type: "text",
        text: result.content,
      },
    };
  };
}

/**
 * Flatten the MCP `messages[]` list into a single prompt string.
 *
 * MCP supports text / image / audio / resource content blocks; we
 * only render the text blocks (the local LLM cannot consume the
 * binary block types over this path). Image-only requests degrade
 * to an empty assistant content slot, which is the same fail-open
 * shape the SDK uses elsewhere.
 *
 * Format:
 *
 *   [system: <systemPrompt>]
 *   user: <text>
 *   assistant: <text>
 *   ...
 *   assistant:
 */
function flattenMessagesToPrompt(
  messages: CreateMessageRequest["params"]["messages"],
  systemPrompt: string | undefined,
): string {
  const lines: string[] = [];
  if (systemPrompt && systemPrompt.length > 0) {
    lines.push(`system: ${systemPrompt}`);
  }
  for (const m of messages) {
    const text = extractMessageText(m.content);
    if (text.length === 0) continue;
    lines.push(`${m.role}: ${text}`);
  }
  lines.push("assistant:");
  return lines.join("\n");
}

function extractMessageText(content: unknown): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}
