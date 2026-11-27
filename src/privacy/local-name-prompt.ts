/**
 * What the local name pass asks the model and how its answer is read
 * (Privacy Shield, ATO-2394). The model returns spans as exact
 * substrings, never offsets: small models count characters badly, and a
 * substring can be checked against the text it came from.
 *
 * The answer is held to one JSON shape twice over: a GBNF grammar for a
 * llama.cpp-family server and the same shape as a JSON schema
 * (`response_format`) for any other OpenAI-compatible server on this
 * machine. Neither is trusted: `parseNameSpans` reads the reply as if no
 * constraint had been applied.
 */

import {
  acceptableModelValue,
  MODEL_PRIVATE_KINDS,
  MODEL_VALUE_MAX_LENGTH,
  type ModelPrivateKind,
} from "./detect-private-data.js";

/** Most spans one answer may carry; the rest of a longer list is ignored. */
export const MAX_SPANS_PER_ANSWER = 64;

export const NAME_DETECTOR_SYSTEM = [
  "You find personal data in text so it can be hidden before the text is sent to another service.",
  "Report every span that is one of:",
  "NAME: a person's name or surname, in any language or script (Ivan Petrov, Иван Петров, Mrs. Smith).",
  "ADDRESS: a street address or a part of one (street, house, flat, postcode with its street).",
  "ORG: a private organisation tied to a person in the text, such as an employer, a clinic or a school.",
  "Do not report programming identifiers, file names, product names, well-known public companies, cities or countries on their own.",
  "Copy each span exactly as it is written in the text, character for character. Do not translate, fix or shorten it.",
  'Answer with JSON only: {"spans":[{"text":"...","kind":"NAME"}]}. With nothing to report, answer {"spans":[]}.',
].join("\n");

/** The user turn: the text, fenced so the model cannot read it as instructions. */
export function buildNameUserPrompt(text: string): string {
  return `Find the spans in this text.\n<text>\n${text}\n</text>`;
}

export const NAME_SPANS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    spans: {
      type: "array",
      maxItems: MAX_SPANS_PER_ANSWER,
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 2, maxLength: MODEL_VALUE_MAX_LENGTH },
          kind: { type: "string", enum: [...MODEL_PRIVATE_KINDS] },
        },
        required: ["text", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["spans"],
  additionalProperties: false,
};

/**
 * The same shape as GBNF. Bounded everywhere: at most 64 spans of at
 * most 200 characters, so a looping model cannot hold the slot for long.
 */
export const NAME_SPANS_GRAMMAR = String.raw`root ::= "{" ws "\"spans\"" ws ":" ws "[" ws spans? ws "]" ws "}"
spans ::= span (ws "," ws span){0,63}
span ::= "{" ws "\"text\"" ws ":" ws str ws "," ws "\"kind\"" ws ":" ws kind ws "}"
kind ::= "\"NAME\"" | "\"ADDRESS\"" | "\"ORG\""
str ::= "\"" chr{1,200} "\""
chr ::= [^"\\\x00-\x1F] | "\\" ["\\/bfnrt]
ws ::= [ \t\n]{0,8}
`;

export interface ReportedSpan {
  text: string;
  kind: ModelPrivateKind;
}

const KIND_SET: ReadonlySet<string> = new Set(MODEL_PRIVATE_KINDS);

/**
 * The spans in a reply, or `null` when the reply is not the expected
 * JSON at all (the caller then learns nothing from it). A reasoning
 * preamble or a code fence around the object is tolerated: the object
 * is read from the first `{` to the last `}`. Items with a wrong shape,
 * an unknown kind or a value the vault could not mask safely are
 * skipped; whether a span is really in the text is the caller's check.
 */
export function parseNameSpans(reply: string): ReportedSpan[] | null {
  const open = reply.indexOf("{");
  const close = reply.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(open, close + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const spans = (parsed as Record<string, unknown>).spans;
  if (!Array.isArray(spans)) return null;
  const out: ReportedSpan[] = [];
  for (const item of spans.slice(0, MAX_SPANS_PER_ANSWER)) {
    if (item === null || typeof item !== "object") continue;
    const { text, kind } = item as Record<string, unknown>;
    if (typeof text !== "string" || typeof kind !== "string") continue;
    if (!KIND_SET.has(kind) || !acceptableModelValue(text)) continue;
    out.push({ text, kind: kind as ModelPrivateKind });
  }
  return out;
}
