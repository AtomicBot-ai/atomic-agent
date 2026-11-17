import { describe, expect, it, vi } from "vitest";

import { GeminiProvider } from "./gemini-provider.js";
import { OpenAiProvider } from "../openai/openai-provider.js";
import { OpenAiHttpError, humanizeOpenAiHttpError } from "../openai/openai-http.js";

/** A tool as an MCP server built on the official TypeScript SDK lists it. */
const MCP_TOOL = {
  type: "function",
  function: {
    name: "mcp__web__open",
    description: "Open a page",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
    },
  },
};

const OK = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

function capturingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(OK), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

type SentTool = { function: { name: string; parameters: Record<string, unknown> } };

describe("tool schemas sent to Gemini's OpenAI-compatible endpoint (ATO-1282)", () => {
  it("leaves out $schema and additionalProperties for a gemini entry", async () => {
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new GeminiProvider({ id: "gemini", apiKey: "k", fetchImpl });
    await provider.complete({ prompt: "hi", tools: [MCP_TOOL] });
    const sent = (bodies[0]!.tools as SentTool[])[0]!;
    expect(sent.function.name).toBe("mcp__web__open");
    expect(sent.function.parameters).toEqual({
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    });
    // The caller's tool is untouched.
    expect(MCP_TOOL.function.parameters).toHaveProperty("$schema");
  });

  it("does the same for an openai-compatible entry pointed at Google's host", async () => {
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new OpenAiProvider({
      id: "my-gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "k",
      defaultChatModel: "gemini-2.5-flash",
      fetchImpl,
    });
    await provider.complete({ prompt: "hi", tools: [MCP_TOOL] });
    const sent = (bodies[0]!.tools as SentTool[])[0]!;
    expect(sent.function.parameters).not.toHaveProperty("$schema");
    expect(sent.function.parameters).not.toHaveProperty("additionalProperties");
  });

  it("sends other services the schema as it was", async () => {
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new OpenAiProvider({
      id: "test",
      baseUrl: "https://example.invalid",
      apiKey: "",
      defaultChatModel: "qwen-test",
      fetchImpl,
    });
    await provider.complete({ prompt: "hi", tools: [MCP_TOOL] });
    expect((bodies[0]!.tools as SentTool[])[0]!.function.parameters).toEqual(MCP_TOOL.function.parameters);
  });
});

type SentResponseFormat = { type: string; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } };

/** A strict helper-call schema, as the memory sub-runners send one. */
const HELPER_FORMAT = {
  name: "vote",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: ["ids"],
  },
};

describe("helper-call response_format sent to Gemini's endpoint (ATO-1444)", () => {
  it("leaves out additionalProperties for a gemini entry", async () => {
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new GeminiProvider({ id: "gemini", apiKey: "k", fetchImpl });
    await provider.complete({ prompt: "pick ids as JSON", responseFormat: HELPER_FORMAT });
    const sent = bodies[0]!.response_format as SentResponseFormat;
    expect(sent.type).toBe("json_schema");
    expect(sent.json_schema.name).toBe("vote");
    expect(sent.json_schema.schema).toEqual({
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    });
    // The caller's schema is untouched.
    expect(HELPER_FORMAT.schema).toHaveProperty("additionalProperties");
  });

  it("does the same for an openai-compatible entry pointed at Google's host", async () => {
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new OpenAiProvider({
      id: "my-gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "k",
      defaultChatModel: "gemini-2.5-flash",
      fetchImpl,
    });
    await provider.complete({ prompt: "pick ids as JSON", responseFormat: HELPER_FORMAT });
    expect((bodies[0]!.response_format as SentResponseFormat).json_schema.schema).not.toHaveProperty("additionalProperties");
  });

  it("sends other services the schema as it was", async () => {
    const { fetchImpl, bodies } = capturingFetch();
    const provider = new OpenAiProvider({
      id: "test",
      baseUrl: "https://example.invalid",
      apiKey: "",
      defaultChatModel: "qwen-test",
      fetchImpl,
    });
    await provider.complete({ prompt: "pick ids as JSON", responseFormat: HELPER_FORMAT });
    expect((bodies[0]!.response_format as SentResponseFormat).json_schema.schema).toEqual(HELPER_FORMAT.schema);
  });
});

describe("Gemini's 404 for a model it does not serve (ATO-1282)", () => {
  it("names the model instead of a raw 404", async () => {
    const body =
      '[{\n  "error": {\n    "code": 404,\n    "message": "models/gemini-9-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.",\n    "status": "NOT_FOUND"\n  }\n}\n]\n';
    const fetchImpl = vi.fn(async () => new Response(body, { status: 404, headers: { "content-type": "application/json" } }));
    const provider = new GeminiProvider({
      id: "gemini",
      apiKey: "k",
      defaultChatModel: "gemini-9-flash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await provider.complete({ prompt: "hi" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAiHttpError);
    // Not a transient failure: asked once.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(humanizeOpenAiHttpError(error as OpenAiHttpError)).toBe(
      '"gemini" answered 404: the model "gemini-9-flash" is not available on Gemini. ' +
        "Check the model id against the Gemini model list, or pick another model.",
    );
  });

  it("does not blame the model for a Gemini 404 that names none (wrong base path)", () => {
    const err = new OpenAiHttpError(
      "openai provider 404: Not Found",
      404,
      "https://generativelanguage.googleapis.com/v1beta/chat/completions",
      false,
      null,
      "gemini",
    );
    expect(humanizeOpenAiHttpError(err)).toBe('"gemini" answered 404 (not found). The model id or the base URL is likely wrong.');
  });

  it("keeps the generic 404 wording for other cloud services", () => {
    const err = new OpenAiHttpError("openai provider 404: not found", 404, "https://api.example.com/v1/chat/completions", false, null, "testprov");
    expect(humanizeOpenAiHttpError(err)).toBe('"testprov" answered 404 (not found). The model id or the base URL is likely wrong.');
  });
});
