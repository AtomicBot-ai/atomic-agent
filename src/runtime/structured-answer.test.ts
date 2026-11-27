import { describe, expect, it, vi } from "vitest";

import {
  STRUCTURED_ANSWER_EMIT_FUNCTION,
  STRUCTURED_ANSWER_SESSION_PREFIX,
  buildStructuredAnswerRequest,
  shapeStructuredAnswer,
} from "./structured-answer.js";

/** ATO-2440: the side call behind `run --output-schema`. */
describe("structured answer side call", () => {
  const schema = { type: "array", items: { type: "string" } };
  const input = { task: "list files", answer: "a.ts and b.ts", schema, sessionId: "s-1" };
  const signal = new AbortController().signal;

  it("holds a local (grammar) link to the schema with GBNF", () => {
    const { request, wrapped } = buildStructuredAnswerRequest(
      input,
      { transport: () => "grammar", slotId: () => 3, serverTemplate: () => true },
      signal,
    );
    expect(wrapped).toBe(false);
    expect(request.grammar).toContain("root ::=");
    expect(request.slotId).toBe(3);
    expect(request.sessionId).toBe(`${STRUCTURED_ANSWER_SESSION_PREFIX}s-1`);
    expect(request.prompt).toContain("a.ts and b.ts");
    expect(request.tools).toBeUndefined();
  });

  it("asks a cloud (native tools) link for one function with the schema, a non-object wrapped", () => {
    const { request, wrapped } = buildStructuredAnswerRequest(
      { ...input, providerId: "openai" },
      { transport: () => "native_tools", slotId: () => 3 },
      signal,
    );
    expect(wrapped).toBe(true);
    expect(request.grammar).toBe("");
    expect(request.providerId).toBe("openai");
    const tool = request.tools![0] as { function: { name: string; parameters: Record<string, unknown> } };
    expect(tool.function.name).toBe(STRUCTURED_ANSWER_EMIT_FUNCTION);
    expect(tool.function.parameters).toMatchObject({ properties: { data: schema }, required: ["data"] });
  });

  it("reads the JSON back from either shape and never throws", async () => {
    const local = await shapeStructuredAnswer(input, {
      complete: vi.fn().mockResolvedValue({ content: '["a.ts","b.ts"]' }),
      transport: () => "grammar",
      slotId: () => 0,
    });
    expect(local).toEqual({ ok: true, value: ["a.ts", "b.ts"] });
    const cloud = await shapeStructuredAnswer(input, {
      complete: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [{ function: { name: STRUCTURED_ANSWER_EMIT_FUNCTION, arguments: '{"data":["a.ts"]}' } }],
      }),
      transport: () => "native_tools",
      slotId: () => 0,
    });
    expect(cloud).toEqual({ ok: true, value: ["a.ts"] });
    const failed = await shapeStructuredAnswer(input, {
      complete: vi.fn().mockRejectedValue(new Error("boom")),
      transport: () => "grammar",
      slotId: () => 0,
    });
    expect(failed).toEqual({ ok: false, reason: "boom" });
    expect(await shapeStructuredAnswer(input, undefined)).toEqual({
      ok: false,
      reason: "no model is available to shape the answer",
    });
  });
});
