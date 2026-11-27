#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  createLocalNameDetector,
  PrivacyVault,
  refineFoundValues,
  type LocalNameModel,
} from "../../src/privacy/index.js";
import {
  NAME_DETECTOR_SYSTEM,
  NAME_SPANS_GRAMMAR,
  NAME_SPANS_SCHEMA,
  buildNameUserPrompt,
  parseNameSpans,
} from "../../src/privacy/local-name-prompt.js";
import { checkFixtures, scoreLetter, summarize, type FixtureLetter, type LetterScore } from "../harness/privacy-names/score.js";

/**
 * `npm run eval:privacy-names -- [--url http://127.0.0.1:8080/v1] [--model name]
 *   [--lang en|ru|all] [--mode gbnf|schema] [--timeout 8000] [--chunk 4000] [--calls 4]
 *   [--out path.json]`
 *
 * Privacy Shield names benchmark (ATO-2527): the 50 letters in
 * `eval/fixtures/privacy-names/` (25 English, 25 Russian, all people and
 * places made up) go through the real local name pass, the same prompt,
 * grammar, chunking and filter the agent uses, against a model server
 * on this machine. Prints recall (what would still reach the cloud),
 * precision (ordinary words masked for nothing) and latency per
 * language, and writes every leak and false positive to a JSON report in
 * `eval/reports/` for tuning the prompt, the 8 s budget and the chunk size.
 *
 * Before the letters it checks that the server takes the GBNF grammar
 * with its bounded repeats (`{0,63}`, `{1,200}`, `{0,8}`): a llama.cpp
 * build that cannot parse them answers 400 here, and the report says so.
 * With `--mode schema` the JSON schema goes as `response_format` instead
 * (LM Studio, Ollama, vLLM).
 *
 * Needs a running server; it is not part of `npm test`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8080/v1" },
    model: { type: "string", default: "local" },
    "api-key": { type: "string" },
    lang: { type: "string", default: "all" },
    mode: { type: "string", default: "gbnf" },
    timeout: { type: "string", default: "8000" },
    chunk: { type: "string", default: "4000" },
    calls: { type: "string", default: "4" },
    out: { type: "string" },
  },
});

const baseUrl = args.url!.replace(/\/+$/, "");
const mode = args.mode === "schema" ? "schema" : "gbnf";
const langs = args.lang === "all" ? ["en", "ru"] : [args.lang!];

interface CallInput {
  system: string;
  user: string;
  signal?: AbortSignal;
}

async function chat({ system, user, signal }: CallInput): Promise<Response> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: 768,
    chat_template_kwargs: { enable_thinking: false },
    ...(mode === "gbnf"
      ? { grammar: NAME_SPANS_GRAMMAR }
      : { response_format: { type: "json_schema", json_schema: { name: "privacy_spans", schema: NAME_SPANS_SCHEMA, strict: true } } }),
  };
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(args["api-key"] ? { authorization: `Bearer ${args["api-key"]}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function replyText(res: Response): Promise<string> {
  if (!res.ok) throw new Error(`server answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

const model: LocalNameModel = {
  id: `${args.model}@${baseUrl}`,
  local: true,
  complete: async ({ system, user, signal }) => replyText(await chat({ system, user, signal })),
};

/** Whether the server takes the grammar (or schema) and answers in its shape. */
async function constraintCheck(): Promise<{ accepted: boolean; detail: string }> {
  try {
    const reply = await replyText(
      await chat({ system: NAME_DETECTOR_SYSTEM, user: buildNameUserPrompt("Anna Lee met Bob Ray at Acme Logistics.") }),
    );
    const spans = parseNameSpans(reply);
    if (spans === null) return { accepted: false, detail: `reply is not the expected JSON: ${reply.slice(0, 200)}` };
    return { accepted: true, detail: `${spans.length} spans in the sample reply` };
  } catch (err) {
    return { accepted: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function runLetter(letter: FixtureLetter): Promise<LetterScore> {
  let failed = false;
  // A fresh detector per letter: no cache from the letter before.
  const detector = createLocalNameDetector({
    model: () => model,
    timeoutMs: Number(args.timeout),
    maxChunkChars: Number(args.chunk),
    maxCallsPerDetect: Number(args.calls),
    onError: () => {
      failed = true;
    },
    onLeftover: () => {
      failed = true;
    },
  });
  const started = performance.now();
  const found = refineFoundValues(await detector.detect(() => [letter.text]));
  const latencyMs = Math.round(performance.now() - started);
  const vault = new PrivacyVault();
  vault.learn(found);
  return scoreLetter(letter, found, vault.mask(letter.text), latencyMs, failed);
}

async function main(): Promise<void> {
  const check = await constraintCheck();
  console.log(`${mode === "gbnf" ? "GBNF grammar" : "JSON schema"}: ${check.accepted ? "accepted" : "NOT accepted"} (${check.detail})`);
  const report: Record<string, unknown> = { url: baseUrl, model: args.model, mode, constraint: check, settings: { timeoutMs: Number(args.timeout), chunkChars: Number(args.chunk), calls: Number(args.calls) } };
  for (const lang of langs) {
    const letters = JSON.parse(readFileSync(join(here, `../fixtures/privacy-names/${lang}.json`), "utf8")) as FixtureLetter[];
    const problems = checkFixtures(letters);
    if (problems.length > 0) throw new Error(`fixtures ${lang}: ${problems.join("; ")}`);
    const scores: LetterScore[] = [];
    for (const letter of letters) scores.push(await runLetter(letter));
    const summary = summarize(scores);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    console.log(
      `${lang}: recall ${pct(summary.recall)} (${summary.covered}/${summary.expected}), precision ${pct(summary.precision)} (${summary.correct}/${summary.found}), ` +
        `latency p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms, max ${summary.latencyMs.max} ms, failed letters ${summary.failedLetters}`,
    );
    for (const s of scores) {
      if (s.leaked.length > 0) console.log(`  ${s.id} leaked: ${s.leaked.join(" | ")}`);
      if (s.falsePositives.length > 0) console.log(`  ${s.id} masked for nothing: ${s.falsePositives.join(" | ")}`);
    }
    report[lang] = { summary, letters: scores };
  }
  const out = args.out ?? join(here, `../reports/privacy-names-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${out}`);
}

await main();
