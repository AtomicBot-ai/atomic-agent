/**
 * Integration smoke for the Variant B "JSON Schema for cloud" plumbing.
 *
 * Hits the full stack end-to-end:
 *   responseFormat
 *     -> OpenAiProvider.complete
 *       -> buildOpenAiChatBody
 *         -> wire payload to /v1/chat/completions
 *           -> mock fetchImpl returns canned cloud reply
 *             -> parseXxxOutput ingests the JSON shape
 *
 * Skipped paths (intentional — covered by unit tests):
 *   - Local llama-server / GBNF transport (this file is cloud-only).
 *   - reflection-runner (still on the synthetic emit_* tool envelope).
 *   - Slot manager, abort signals, timers, metrics (per-runner tests).
 *
 * The smoke is deliberately read-only on storage — it never opens
 * SQLite. The point is to prove the request payload carries the
 * right response_format AND the parser ingests the cloud reply.
 */
import { describe, expect, it } from "vitest";

import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";

import { LINK_GENERATOR_RESPONSE_FORMAT } from "../memory/links/link-generator-response-format.js";
import { parseLinkGeneratorOutput } from "../memory/links/link-generator-parser.js";

import { VOTE_RESPONSE_FORMAT } from "../memory/voting/vote-response-format.js";
import { parseVoteOutput } from "../memory/voting/vote-parser.js";

import { QUERY_REWRITER_RESPONSE_FORMAT } from "../memory/retrieve/query-rewriter-response-format.js";
import { parseRewriterOutput } from "../memory/retrieve/query-rewriter-parser.js";

import {
  DISTILL_RESPONSE_FORMAT,
  DISTILL_WITH_PROCEDURE_RESPONSE_FORMAT,
} from "../memory/consolidator/distill-response-format.js";
import {
  parseDistillOutput,
  parseDistillWithProcedureOutput,
} from "../memory/consolidator/distill-parser.js";

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
  authHeader: string | null;
}

/**
 * Build a mock fetchImpl that always returns the given assistant
 * content. Captures every outbound request body so the smoke can
 * assert that the wire carried the right response_format envelope.
 */
function buildMockFetch(assistantContent: string) {
  const captured: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = { raw: init.body };
      }
    }
    const headers = new Headers(init?.headers ?? {});
    captured.push({
      url,
      method,
      body,
      authHeader: headers.get("authorization"),
    });
    const payload = {
      id: "chatcmpl-smoke",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: (body["model"] as string | undefined) ?? "smoke-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: assistantContent,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, captured };
}

function makeProvider(fetchImpl: typeof fetch): OpenAiProvider {
  return new OpenAiProvider({
    id: "smoke-openai",
    baseUrl: "https://example.invalid",
    apiKey: "sk-smoke",
    defaultChatModel: "smoke-model",
    fetchImpl,
  });
}

describe("Variant B smoke — JSON Schema response_format round-trip", () => {
  it("link-generator: forwards schema to wire AND parses canned cloud reply", async () => {
    const cloudReply = JSON.stringify({
      kind: "links",
      links: [
        { from_id: 12, to_id: 17, link_kind: "RELATES_TO" },
        { from_id: 17, to_id: 12, link_kind: "REFERENCES" },
      ],
    });
    const { fetchImpl, captured } = buildMockFetch(cloudReply);
    const provider = makeProvider(fetchImpl);

    const result = await provider.complete({
      prompt: "candidates: 12, 17",
      responseFormat: LINK_GENERATOR_RESPONSE_FORMAT,
    });

    // Wire payload assertions.
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe("https://example.invalid/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.authHeader).toBe("Bearer sk-smoke");
    expect(req.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "link_generator_v1",
        strict: true,
      },
    });
    // Schema body forwarded verbatim — enum values, required keys.
    const jsonSchema = (req.body.response_format as {
      json_schema: { schema: Record<string, unknown> };
    }).json_schema.schema;
    expect((jsonSchema.properties as Record<string, unknown>).kind)
      .toMatchObject({ enum: ["none", "links"] });

    // Parser roundtrip.
    expect(result.content).toBe(cloudReply);
    const parsed = parseLinkGeneratorOutput(result.content, {
      allowlist: new Set([12, 17]),
    });
    expect(parsed.kind).toBe("links");
    if (parsed.kind !== "links") throw new Error();
    expect(parsed.links).toEqual([
      { fromId: 12, toId: 17, kind: "RELATES_TO" },
      { fromId: 17, toId: 12, kind: "REFERENCES" },
    ]);
  });

  it("vote-runner: forwards schema to wire AND parses canned cloud reply", async () => {
    const cloudReply = JSON.stringify({
      kind: "votes",
      votes: [
        { target_kind: "memory", target_id: 42, direction: 1 },
        { target_kind: "lesson", target_id: 7, direction: -1 },
        { target_kind: "profile", target_id: 3, direction: 1 },
      ],
    });
    const { fetchImpl, captured } = buildMockFetch(cloudReply);
    const provider = makeProvider(fetchImpl);

    const result = await provider.complete({
      prompt: "surfaced: m:42, l:7, p:3",
      responseFormat: VOTE_RESPONSE_FORMAT,
    });

    expect(captured[0]!.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "vote_runner_v1", strict: true },
    });
    const jsonSchema = (captured[0]!.body.response_format as {
      json_schema: { schema: Record<string, unknown> };
    }).json_schema.schema;
    const voteItems = (
      ((jsonSchema.properties as Record<string, unknown>).votes as {
        items: { properties: { target_kind: { enum: string[] } } };
      }).items.properties.target_kind
    ).enum;
    expect(voteItems).toEqual([
      "memory",
      "lesson",
      "profile",
      "procedure",
    ]);

    const parsed = parseVoteOutput(result.content, {
      allowlist: {
        memory: new Set([42]),
        lesson: new Set([7]),
        profile: new Set([3]),
        procedure: new Set(),
      },
    });
    expect(parsed.kind).toBe("votes");
    if (parsed.kind !== "votes") throw new Error();
    expect(parsed.votes).toEqual([
      { kind: "memory", targetId: 42, direction: 1 },
      { kind: "lesson", targetId: 7, direction: -1 },
      { kind: "profile", targetId: 3, direction: 1 },
    ]);
  });

  it("query-rewriter: forwards schema to wire AND parses canned cloud reply", async () => {
    const cloudReply = JSON.stringify({
      rewritten_query: "did Tony mention the dental implant?",
    });
    const { fetchImpl, captured } = buildMockFetch(cloudReply);
    const provider = makeProvider(fetchImpl);

    const result = await provider.complete({
      prompt: "ambiguous: 'did he mention it?'",
      responseFormat: QUERY_REWRITER_RESPONSE_FORMAT,
    });

    expect(captured[0]!.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "query_rewriter_v1", strict: true },
    });

    const parsed = parseRewriterOutput(result.content);
    expect(parsed).toBe("did Tony mention the dental implant?");
  });

  it("query-rewriter: cloud abstain via NONE literal short-circuits the parser to null", async () => {
    const { fetchImpl } = buildMockFetch(
      JSON.stringify({ rewritten_query: "NONE" }),
    );
    const provider = makeProvider(fetchImpl);
    const result = await provider.complete({
      prompt: "non-referential",
      responseFormat: QUERY_REWRITER_RESPONSE_FORMAT,
    });
    expect(parseRewriterOutput(result.content)).toBeNull();
  });

  it("distill (lesson-only): forwards schema to wire AND parses canned cloud reply", async () => {
    const cloudReply = JSON.stringify({
      kind: "lesson",
      activation: "When asked about pnpm",
      principle: "Always use pnpm install over npm install.",
      tags: ["tool", "pnpm"],
    });
    const { fetchImpl, captured } = buildMockFetch(cloudReply);
    const provider = makeProvider(fetchImpl);

    const result = await provider.complete({
      prompt: "cluster of 3 pnpm episodes",
      responseFormat: DISTILL_RESPONSE_FORMAT,
    });

    expect(captured[0]!.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "distill_lesson_v1", strict: true },
    });
    const parsed = parseDistillOutput(result.content);
    expect(parsed).toEqual({
      kind: "lesson",
      activation: "When asked about pnpm",
      principle: "Always use pnpm install over npm install.",
      tags: ["tool", "pnpm"],
    });
  });

  it("distill+procedure: forwards schema to wire AND parses canned cloud reply with steps[]", async () => {
    const cloudReply = JSON.stringify({
      kind: "lesson",
      activation: "extract typescript signatures",
      principle: "Glob, grep, then summarise.",
      tags: ["typescript", "glob"],
      procedure: {
        activation: "want exported signatures",
        steps: [
          { description: "glob *.ts", tool_hint: "os.fs.glob" },
          { description: "grep export", tool_hint: "os.fs.grep" },
          { description: "summarise", tool_hint: null },
        ],
        tags: ["typescript"],
      },
    });
    const { fetchImpl, captured } = buildMockFetch(cloudReply);
    const provider = makeProvider(fetchImpl);

    const result = await provider.complete({
      prompt: "cluster of 3 ts-export episodes",
      responseFormat: DISTILL_WITH_PROCEDURE_RESPONSE_FORMAT,
    });

    expect(captured[0]!.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "distill_lesson_and_procedure_v1",
        strict: true,
      },
    });
    // The combined schema must include the procedure half — assert
    // its presence rather than the full anyOf shape (libraries that
    // normalise schemas can collapse anyOf differently).
    const distillSchema = (captured[0]!.body.response_format as {
      json_schema: { schema: Record<string, unknown> };
    }).json_schema.schema;
    expect((distillSchema.properties as Record<string, unknown>).procedure)
      .toBeDefined();
    expect(distillSchema.required).toContain("procedure");

    const parsed = parseDistillWithProcedureOutput(result.content);
    expect(parsed.kind).toBe("lesson");
    if (parsed.kind !== "lesson") throw new Error();
    expect(parsed.activation).toBe("extract typescript signatures");
    expect(parsed.procedure).not.toBeNull();
    expect(parsed.procedure!.steps).toEqual([
      { description: "glob *.ts", toolHint: "os.fs.glob" },
      { description: "grep export", toolHint: "os.fs.grep" },
      { description: "summarise", toolHint: null },
    ]);
    expect(parsed.procedure!.tags).toEqual(["typescript"]);
  });

  it("distill (abstain): kind=none on cloud is honoured by the parser", async () => {
    const cloudReply = JSON.stringify({
      kind: "none",
      // Structured Outputs strict=true forces all required keys —
      // the cloud reply ships filler values that the parser ignores.
      activation: "",
      principle: "",
      tags: [],
    });
    const { fetchImpl } = buildMockFetch(cloudReply);
    const provider = makeProvider(fetchImpl);
    const result = await provider.complete({
      prompt: "indistinct cluster",
      responseFormat: DISTILL_RESPONSE_FORMAT,
    });
    expect(parseDistillOutput(result.content)).toEqual({ kind: "none" });
  });

  it("does NOT attach response_format alongside tools (vendor compatibility)", async () => {
    // The agent loop itself uses `tools` and never sets
    // `responseFormat` — but if a caller does both, the build helper
    // strips `response_format` to avoid Azure/OpenRouter rejection.
    // This invariant is load-bearing for the main agent path.
    const { fetchImpl, captured } = buildMockFetch(
      JSON.stringify({
        id: "anything",
        object: "chat.completion",
        choices: [
          {
            message: { role: "assistant", content: "" },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const provider = makeProvider(fetchImpl);
    await provider.complete({
      prompt: "main agent step",
      tools: [
        {
          type: "function",
          function: { name: "reply", parameters: { type: "object" } },
        },
      ],
      toolChoice: "auto",
      responseFormat: DISTILL_RESPONSE_FORMAT,
    });
    expect(captured[0]!.body.tools).toBeDefined();
    expect(captured[0]!.body.response_format).toBeUndefined();
  });
});
