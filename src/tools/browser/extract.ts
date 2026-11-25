import { compressToolResult } from "../../compressor/result-compressor.js";
import { assertSupportedJsonSchema } from "../../llm/provider/openai/json-schema-support.js";
import { validateJsonSchemaValue } from "../../llm/provider/openai/coerce-json-schema-value.js";
import { JsonSchemaGbnfError } from "../../llm/grammar/json-schema-gbnf.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ToolDefinition } from "../tool-registry.js";
import { BROWSER_PAGE_SOURCE } from "../untrusted-tool-output.js";
import { newUntrustedNonce } from "../untrusted-text.js";
import type { BrowserBackend } from "./browser-backend.js";
import {
  blockedDomainMessage,
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { gatePageRead } from "./gate-page-read.js";
import {
  buildExtractPrompt,
  buildExtractRequest,
  readExtractedJson,
  type BrowserExtractModelRef,
} from "./extract-request.js";

export const BROWSER_EXTRACT_TOOL = "browser.extract";

/** Largest schema accepted, as JSON text. */
export const EXTRACT_MAX_SCHEMA_CHARS = 16_000;
/** Longest `instruction`. */
export const EXTRACT_MAX_INSTRUCTION_CHARS = 2_000;
/** Page text sent when the model's window is unknown. */
export const EXTRACT_DEFAULT_PAGE_CHARS = 48_000;
const EXTRACT_MIN_PAGE_CHARS = 8_000;
const EXTRACT_MAX_PAGE_CHARS = 200_000;
/** Share of the window the page may take: the rest is schema, prompt and the answer. */
const PAGE_WINDOW_SHARE = 0.5;
const CHARS_PER_TOKEN = 3;
/** Longest JSON echoed in the tool summary; `details.data` keeps all of it. */
const EXTRACT_MAX_OUTPUT_CHARS = 20_000;
/** A local model can take a while on a long page. */
export const EXTRACT_TIMEOUT_MS = 180_000;

/** How much page text the side call gets for a window of `contextWindowTokens`. */
export function extractPageBudget(contextWindowTokens?: number): number {
  if (contextWindowTokens === undefined || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return EXTRACT_DEFAULT_PAGE_CHARS;
  }
  const chars = Math.round(contextWindowTokens * PAGE_WINDOW_SHARE * CHARS_PER_TOKEN);
  return Math.min(EXTRACT_MAX_PAGE_CHARS, Math.max(EXTRACT_MIN_PAGE_CHARS, chars));
}

function errorResult(output: string, details: Record<string, unknown>) {
  return compressToolResult({ tool: BROWSER_EXTRACT_TOOL, status: "error", output: `${BROWSER_EXTRACT_TOOL}: ${output}`, details });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

function parseSchema(raw: unknown): Record<string, unknown> | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "`schema` must be a JSON Schema object, e.g. { \"type\": \"object\", \"properties\": { ... } }";
  }
  const schema = raw as Record<string, unknown>;
  if (JSON.stringify(schema).length > EXTRACT_MAX_SCHEMA_CHARS) {
    return `\`schema\` is too large (over ${EXTRACT_MAX_SCHEMA_CHARS} characters)`;
  }
  try {
    assertSupportedJsonSchema(schema);
  } catch (err) {
    return `\`schema\` is not supported: ${err instanceof Error ? err.message : String(err)}`;
  }
  return schema;
}

/**
 * `browser.extract { schema, instruction? }` (ATO-699): pull structured
 * data out of the active page in one call ("all plan prices as a
 * table") instead of a read / scroll chain. The page's full ARIA
 * snapshot and the schema go to one model call constrained to the
 * schema: GBNF built from it on a grammar (local) link, a one-function
 * schema on a native-tools link. The answer is checked against the
 * schema before it is returned.
 *
 * The page goes through the same check as `read_aria` (`gate-page-read.ts`):
 * a blocked page or frame is refused, and in the user's own Chrome a site
 * not cleared this session asks first. The page text sits in an
 * untrusted block in the side call's prompt, and the result is framed as
 * page content (`untrustedOutput`): the values are the site's text.
 */
export function buildBrowserExtractTool(
  backend: BrowserBackend,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  model: BrowserExtractModelRef = {},
  dangerous?: DangerousToolOptions,
): ToolDefinition {
  return {
    name: BROWSER_EXTRACT_TOOL,
    description:
      "Extract structured data from the active page into JSON matching `schema` (a JSON Schema), with an optional `instruction`. One model call over the whole page; the result is validated against the schema.",
    readonly: true,
    untrustedOutput: BROWSER_PAGE_SOURCE,
    async run(rawArgs, ctx) {
      const schema = parseSchema(rawArgs.schema);
      if (typeof schema === "string") return errorResult(schema, { reason: "bad_schema" });
      const instructionRaw = rawArgs.instruction;
      if (instructionRaw !== undefined && instructionRaw !== null && typeof instructionRaw !== "string") {
        return errorResult("`instruction` must be a string", { reason: "bad_instruction" });
      }
      const instruction = typeof instructionRaw === "string" ? instructionRaw.trim() : "";
      if (instruction.length > EXTRACT_MAX_INSTRUCTION_CHARS) {
        return errorResult(`\`instruction\` is too long (over ${EXTRACT_MAX_INSTRUCTION_CHARS} characters)`, { reason: "bad_instruction" });
      }
      const extractor = model.current;
      if (!extractor) {
        return errorResult("no model is available for extraction; use browser.read_aria instead", { reason: "no_model" });
      }

      await backend.ensureReady();
      const snapshot = await backend.snapshot({ full: true });
      const gate = await gatePageRead(
        snapshot,
        policy,
        ctx.sessionId,
        dangerous ? { dangerous, tool: BROWSER_EXTRACT_TOOL, signal: ctx.signal } : undefined,
      );
      if (gate.kind === "blocked") {
        return compressToolResult({
          tool: BROWSER_EXTRACT_TOOL,
          status: "error",
          output: blockedDomainMessage(BROWSER_EXTRACT_TOOL, gate.host),
          details: { host: gate.host, reason: "blocked_domain" },
        });
      }
      if (gate.kind === "user_site_not_cleared") {
        return errorResult(`${gate.host} has not been opened in your own Chrome this session`, {
          host: gate.host,
          reason: "user_site_not_cleared",
        });
      }

      const budget = extractPageBudget(ctx.contextWindowTokens);
      const truncated = snapshot.text.length > budget;
      const prompt = buildExtractPrompt({
        url: snapshot.url,
        title: snapshot.title,
        pageText: truncated ? snapshot.text.slice(0, budget) : snapshot.text,
        truncated,
        schema,
        ...(instruction ? { instruction } : {}),
        nonce: newUntrustedNonce(),
      });

      let built: ReturnType<typeof buildExtractRequest>;
      try {
        built = buildExtractRequest({
          prompt,
          schema,
          transport: extractor.transport(ctx.providerId),
          sessionId: ctx.sessionId,
          slotId: extractor.slotId(),
          serverTemplate: extractor.serverTemplate?.() ?? true,
          ...(ctx.providerId !== undefined ? { providerId: ctx.providerId } : {}),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(EXTRACT_TIMEOUT_MS)]),
        });
      } catch (err) {
        if (err instanceof JsonSchemaGbnfError) return errorResult(`\`schema\` cannot be used: ${err.message}`, { reason: "bad_schema" });
        throw err;
      }

      let completion: Awaited<ReturnType<typeof extractor.complete>>;
      try {
        completion = await extractor.complete(built.request);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return errorResult(`the extraction call failed: ${err instanceof Error ? err.message : String(err)}`, {
          url: snapshot.url,
          reason: "model_failed",
        });
      }

      const parsed = readExtractedJson(completion, built.wrapped);
      if (!parsed.ok) {
        return errorResult("the model did not answer with JSON; try a simpler schema or browser.read_aria", {
          url: snapshot.url,
          reason: "not_json",
        });
      }
      const json = JSON.stringify(parsed.value, null, 2);
      if (!validateJsonSchemaValue(parsed.value, schema)) {
        return errorResult(`the extracted JSON does not match the schema:\n${clip(json, EXTRACT_MAX_OUTPUT_CHARS)}`, {
          url: snapshot.url,
          reason: "schema_mismatch",
        });
      }
      const output = [
        `extracted data from the page`,
        `  url: ${snapshot.url}`,
        `  title: ${snapshot.title}`,
        ...(truncated ? [`  note: the page was cut at ${budget} characters before extraction`] : []),
        clip(json, EXTRACT_MAX_OUTPUT_CHARS),
      ].join("\n");
      return compressToolResult({
        tool: BROWSER_EXTRACT_TOOL,
        status: "ok",
        output,
        details: { url: snapshot.url, title: snapshot.title, data: parsed.value, pageTruncated: truncated },
      });
    },
  };
}
