import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  loadOutputSchema,
  settleStructuredAnswer,
  withSchemaInstruction,
} from "./run-output-schema.js";

/** ATO-2440: `run --output-schema`. */
describe("run output schema", () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };

  it("loads a schema from a file or inline JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-output-schema-"));
    try {
      const file = join(dir, "s.json");
      writeFileSync(file, JSON.stringify(schema), "utf8");
      expect(loadOutputSchema(file)).toEqual(schema);
      expect(loadOutputSchema(JSON.stringify(schema))).toEqual(schema);
      expect(loadOutputSchema(join(dir, "missing.json"))).toEqual({
        error: expect.stringContaining("cannot read"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses JSON that is not a schema it can check", () => {
    expect(loadOutputSchema("{oops")).toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(loadOutputSchema('{"type":"date"}')).toEqual({ error: expect.stringContaining("unsupported") });
  });

  it("asks the turn for the JSON shape after the person's message", () => {
    const message = withSchemaInstruction("check it", schema);
    expect(message.startsWith("check it\n")).toBe(true);
    expect(message).toContain(JSON.stringify(schema));
  });

  it("takes a matching reply as is and never calls the side model", async () => {
    const shape = vi.fn();
    const settled = await settleStructuredAnswer({
      reply: '```json\n{"ok": true}\n```',
      task: "t",
      schema,
      sessionId: "s",
      shape,
    });
    expect(settled).toEqual({ ok: true, value: { ok: true }, shaped: false });
    expect(shape).not.toHaveBeenCalled();
  });

  it("shapes a prose reply and checks what comes back", async () => {
    const shape = vi.fn().mockResolvedValue({ ok: true, value: { ok: false } });
    const settled = await settleStructuredAnswer({
      reply: "it did not work",
      task: "check it",
      schema,
      sessionId: "s-1",
      providerId: "openai",
      shape,
    });
    expect(settled).toEqual({ ok: true, value: { ok: false }, shaped: true });
    expect(shape).toHaveBeenCalledWith(
      expect.objectContaining({ answer: "it did not work", task: "check it", sessionId: "s-1", providerId: "openai" }),
    );
    const bad = await settleStructuredAnswer({
      reply: "it did not work",
      task: "t",
      schema,
      sessionId: "s",
      shape: vi.fn().mockResolvedValue({ ok: true, value: { ok: "no" } }),
    });
    expect(bad).toEqual({ ok: false, error: "the answer does not match the schema" });
  });

  it("is an error when there is no answer or the side call fails", async () => {
    expect(await settleStructuredAnswer({ reply: null, task: "t", schema, sessionId: "s" })).toEqual({
      ok: false,
      error: "the run ended without an answer",
    });
    const failed = await settleStructuredAnswer({
      reply: "prose",
      task: "t",
      schema,
      sessionId: "s",
      shape: vi.fn().mockResolvedValue({ ok: false, reason: "timed out" }),
    });
    expect(failed).toEqual({ ok: false, error: "the answer could not be put into the schema: timed out" });
  });
});
