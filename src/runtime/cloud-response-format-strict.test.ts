/**
 * Every memory sub-call `response_format` must fit OpenAI strict mode.
 *
 * The provider compiles a strict schema before the model runs and
 * refuses the request when a single object leaves a key optional — the
 * link-generator and vote schemas did, and every one of their calls on
 * an OpenAI model answered 400.
 *
 * The formats are discovered, not listed: any `*-response-format.ts`
 * under `src/` is imported and every schema it exports is checked, so a
 * new sub-call cannot ship a schema that skips this test. The known
 * five are asserted by name so the discovery itself cannot go vacuous.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { ResponseFormatJsonSchema } from "../llm/provider/completion-types.js";
import { assertSupportedJsonSchema } from "../llm/provider/openai/json-schema-support.js";
import { findStrictSchemaViolations } from "../llm/provider/openai/find-strict-schema-violations.js";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

function findResponseFormatFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findResponseFormatFiles(path));
    else if (entry.name.endsWith("-response-format.ts")) out.push(path);
  }
  return out;
}

function isResponseFormat(value: unknown): value is ResponseFormatJsonSchema {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.schema !== null &&
    typeof record.schema === "object"
  );
}

async function loadResponseFormats(): Promise<ResponseFormatJsonSchema[]> {
  const formats: ResponseFormatJsonSchema[] = [];
  for (const file of findResponseFormatFiles(SRC_DIR)) {
    const mod = (await import(pathToFileURL(file).href)) as Record<
      string,
      unknown
    >;
    formats.push(...Object.values(mod).filter(isResponseFormat));
  }
  return formats;
}

describe("sub-call response formats fit OpenAI strict mode", () => {
  it("discovers every sub-call schema", async () => {
    const names = (await loadResponseFormats()).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "link_generator_v1",
        "vote_runner_v1",
        "query_rewriter_v1",
        "distill_lesson_v1",
        "distill_lesson_and_procedure_v1",
      ]),
    );
  });

  it("closes every object and requires every key, at every depth", async () => {
    const violations = (await loadResponseFormats()).flatMap((format) =>
      findStrictSchemaViolations(format.schema).map(
        (violation) => `${format.name} ${violation}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("asks for strict decoding and uses only supported keywords", async () => {
    for (const format of await loadResponseFormats()) {
      expect(format.strict, format.name).toBe(true);
      expect(format.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(() => assertSupportedJsonSchema(format.schema)).not.toThrow();
    }
  });
});
