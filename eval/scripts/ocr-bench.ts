#!/usr/bin/env tsx
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { ProviderCapabilities, VisionRequest } from "../../src/llm/provider/llm-provider.js";
import { extractFileText } from "../../src/tools/files/file-text.js";
import type { VisionModel } from "../../src/tools/os/media-text/media-text.js";
import {
  downloadTesseractData,
  formatDataSize,
  tesseractDataDir,
  tesseractDataStatus,
} from "../../src/tools/os/media-text/tesseract-data.js";
import { createTesseractOcrEngine } from "../../src/tools/os/media-text/tesseract-ocr-engine.js";
import { createVisionOcrEngine } from "../../src/tools/os/media-text/vision-ocr-engine.js";
import type { OcrEngine } from "../../src/tools/os/read-document/index.js";
import {
  ocrAccuracy,
  ocrBenchMarkdown,
  summariseOcrBench,
  type OcrBenchRow,
} from "../harness/ocr-metrics.js";

/**
 * `npm run eval:ocr -- --dir <scans> [options]` (ATO-2502)
 *
 * Reads every `<name>.pdf` in `--dir` the way My files does
 * (`extractFileText`, the same page pictures and OCR seam) with each
 * engine, and scores the text against `<name>.txt`, a hand-checked
 * transcript of the same pages. Prints a table and writes JSON and
 * Markdown to `--out`. The procedure, the scan set and where results go:
 * `docs/plans/ocr-russian-scans-benchmark.md`.
 *
 * Engines (`--engines`, default `tesseract,vision`):
 * - `tesseract`: tesseract.js, which is not a dependency; install it for
 *   the run with `npm i --no-save tesseract.js@7.0.0`. Language data is
 *   read from `--data-dir` (default the agent's own folder,
 *   `~/.atomic-agent/models/tesseract/4.0.0_best_int`). Missing data is
 *   fetched only with `--download-data`, after its size is printed.
 * - `vision`: a vision model on an OpenAI-compatible server on this
 *   computer (Atomic Core, llama-server with `--mmproj`, LM Studio):
 *   `--vision-url http://127.0.0.1:19091/v1 --vision-model <id>`.
 *
 * Options: `--languages rus,eng`, `--max-pages 30` (the index's per-file
 * limit), `--out eval/reports/ocr`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, "..", "reports", "ocr");
const DEFAULT_DATA_DIR = tesseractDataDir(join(homedir(), ".atomic-agent", "models"));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      engines: { type: "string", default: "tesseract,vision" },
      languages: { type: "string", default: "rus,eng" },
      "max-pages": { type: "string", default: "30" },
      "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
      "download-data": { type: "boolean", default: false },
      "vision-url": { type: "string", default: "http://127.0.0.1:19091/v1" },
      "vision-model": { type: "string" },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });
  if (!values.dir) throw new Error("--dir <folder with name.pdf + name.txt pairs> is required");
  const dir = resolve(values.dir);
  const languages = values.languages.split(",").map((lang) => lang.trim()).filter(Boolean);
  const maxPages = Number.parseInt(values["max-pages"], 10);
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  const pairs = files.filter((name) => existsSync(join(dir, transcriptName(name))));
  if (pairs.length === 0) throw new Error(`no <name>.pdf with a <name>.txt beside it in ${dir}`);
  for (const name of files) if (!pairs.includes(name)) console.warn(`skip ${name}: no ${transcriptName(name)}`);

  const engines: OcrEngine[] = [];
  for (const id of values.engines.split(",").map((engine) => engine.trim())) {
    if (id === "tesseract") engines.push(await tesseractEngine(values["data-dir"], languages, values["download-data"]));
    else if (id === "vision") engines.push(visionEngine(values["vision-url"], values["vision-model"]));
    else throw new Error(`unknown engine "${id}"; use tesseract, vision`);
  }

  const rows: OcrBenchRow[] = [];
  const refs = new Map<string, { chars: number; words: number }>();
  for (const name of pairs) {
    const reference = readFileSync(join(dir, transcriptName(name)), "utf8");
    const self = ocrAccuracy(reference, reference);
    refs.set(name, { chars: self.referenceChars, words: self.referenceWords });
    for (const engine of engines) {
      const started = performance.now();
      const result = await extractFileText(join(dir, name), { ocr: { engine, maxPages, languages } });
      const seconds = (performance.now() - started) / 1000;
      if (result.status !== "ok") {
        const error = result.status === "skipped" ? result.reason : result.error;
        rows.push({ file: name, engine: engine.id, pages: 0, ocrPages: 0, seconds, cer: null, wer: null, error });
        console.log(`${name}  ${engine.id}  not read: ${error}`);
        continue;
      }
      const text = result.segments.map((segment) => segment.text).join("\n");
      const pages = Math.max(0, ...result.segments.map((segment) => segment.page ?? 0));
      const accuracy = ocrAccuracy(reference, text);
      const ocrPages = result.ocrPages ?? 0;
      rows.push({ file: name, engine: engine.id, pages, ocrPages, seconds, cer: accuracy.cer, wer: accuracy.wer });
      console.log(`${name}  ${engine.id}  ${ocrPages} pages  ${seconds.toFixed(1)} s  CER ${(accuracy.cer * 100).toFixed(1)}%  WER ${(accuracy.wer * 100).toFixed(1)}%`);
    }
  }

  const summary = summariseOcrBench(rows, refs);
  const table = ocrBenchMarkdown(summary);
  console.log(`\n${table}`);
  mkdirSync(values.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(values.out, `ocr-bench-${stamp}`);
  const meta = {
    at: new Date().toISOString(),
    dir: basename(dir),
    languages,
    maxPages,
    visionModel: values.engines.includes("vision") ? (values["vision-model"] ?? null) : null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  writeFileSync(`${base}.json`, `${JSON.stringify({ meta, summary, rows }, null, 2)}\n`);
  writeFileSync(`${base}.md`, `# OCR benchmark ${meta.at}\n\n${table}`);
  console.log(`wrote ${base}.json and ${base}.md`);
}

function transcriptName(pdf: string): string {
  return `${pdf.slice(0, -".pdf".length)}.txt`;
}

async function tesseractEngine(dataDir: string, languages: readonly string[], download: boolean): Promise<OcrEngine> {
  const status = tesseractDataStatus(dataDir, languages);
  if (status.missing.length > 0) {
    const names = status.missing.map((file) => file.lang).join("+");
    console.log(`tesseract language data ${names} is ${formatDataSize(status.missingBytes)} (from cdn.jsdelivr.net), into ${dataDir}`);
    if (!download) throw new Error("rerun with --download-data to fetch it, or copy the .traineddata.gz files there");
    await downloadTesseractData({ dir: dataDir, languages, consent: true });
  }
  const engine = createTesseractOcrEngine({ dataDir });
  const reason = await engine.unavailableReason(languages);
  if (reason !== undefined) throw new Error(`tesseract: ${reason} (npm i --no-save tesseract.js@7.0.0)`);
  return engine;
}

/** A vision model on a local OpenAI-compatible `/chat/completions`. */
function visionEngine(baseUrl: string, model: string | undefined): OcrEngine {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const vision: VisionModel = {
    name: model ?? "local vision model",
    capabilities: { vision: true } as ProviderCapabilities,
    async describeImage(request: VisionRequest) {
      const started = performance.now();
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: request.prompt },
                ...request.images.map((image) => ({
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` },
                })),
              ],
            },
          ],
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return { text: body.choices?.[0]?.message?.content ?? "", durationMs: performance.now() - started };
    },
  };
  return createVisionOcrEngine({ vision });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
