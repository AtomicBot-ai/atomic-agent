import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { compressToolResult } from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type {
  DocumentFormat,
  Extractor,
  ExtractorInput,
} from "./extractors/extractor-types.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 50;

export interface ReadDocumentOptions {
  /**
   * Test-seam: inject a bag of extractors so unit tests can drive the
   * dispatcher in isolation, without the heavy PDF/OOXML libraries.
   */
  extractors?: Partial<Record<DocumentFormat, Extractor>>;
}

interface ReadArgs {
  path: string;
  absolute: string;
  format: DocumentFormat;
  maxBytes: number;
  maxPages?: number;
  pagesFrom?: number;
  pagesTo?: number;
  sheets?: readonly (string | number)[];
  pageSeparators: boolean;
  includeTables: boolean;
}

export function buildOsFsReadDocumentTool(
  options: ReadDocumentOptions = {},
): ToolDefinition {
  return {
    name: "os.fs.read_document",
    description:
      'Extract plain text (with light structure markers) from PDF, DOCX, DOC (legacy), XLSX, RTF, ODT, PPTX, and plain-text files. NOT for source code or other UTF-8 text files — read those with os.fs.read. Auto-detects format by extension; override with `format` (the plain-text value is `format: "plain"`). Read-only, no approval required.',
    readonly: true,
    async run(rawArgs, ctx) {
      const args = await parseArgs(rawArgs, ctx.workingDir);
      const extractor = await resolveExtractor(args.format, options);

      const data = await readFile(args.absolute);
      const input: ExtractorInput = {
        data,
        sourcePath: args.absolute,
        pagesFrom: args.pagesFrom,
        pagesTo: args.pagesTo,
        maxPages: args.maxPages ?? DEFAULT_MAX_PAGES,
        sheets: args.sheets,
        pageSeparators: args.pageSeparators,
        includeTables: args.includeTables,
      };
      const result = await extractor(input);

      const { text, bytesTruncated } = capText(result.text, args.maxBytes);
      const details: Record<string, unknown> = {
        path: args.absolute,
        format: result.format,
        truncated: bytesTruncated,
        warnings: result.warnings,
      };
      if (result.pageCount !== undefined) details.pageCount = result.pageCount;
      if (result.sheetCount !== undefined) details.sheetCount = result.sheetCount;
      if (result.slideCount !== undefined) details.slideCount = result.slideCount;
      if (result.pagesExtracted !== undefined) {
        details.pagesExtracted = result.pagesExtracted;
      }

      return compressToolResult(
        {
          tool: "os.fs.read_document",
          status: "ok",
          output: text,
          details,
        },
        { maxSummaryLength: args.maxBytes, maxTailLines: 5000 },
      );
    },
  };
}

async function parseArgs(
  rawArgs: Record<string, unknown>,
  workingDir: string,
): Promise<ReadArgs> {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(
      "os.fs.read_document: `path` must be a non-empty string",
    );
  }
  const absolute = resolveUserPath(path, workingDir);
  const info = await stat(absolute);
  if (!info.isFile()) {
    throw new Error(
      `os.fs.read_document: ${absolute} is not a regular file`,
    );
  }

  const format = detectFormat(absolute, rawArgs.format);

  const maxBytes = parsePositiveInt(
    rawArgs.maxBytes,
    DEFAULT_MAX_BYTES,
    "maxBytes",
  );
  const maxPages = parseOptionalPositiveInt(rawArgs.maxPages, "maxPages");
  const pagesFrom = parseOptionalPositiveInt(rawArgs.pagesFrom, "pagesFrom");
  const pagesTo = parseOptionalPositiveInt(rawArgs.pagesTo, "pagesTo");
  if (
    pagesFrom !== undefined &&
    pagesTo !== undefined &&
    pagesFrom > pagesTo
  ) {
    throw new Error(
      "os.fs.read_document: pagesFrom must be <= pagesTo",
    );
  }

  const sheets = parseSheetsArg(rawArgs.sheets);
  const pageSeparators = rawArgs.pageSeparators !== false;
  const includeTables = rawArgs.includeTables !== false;

  return {
    path,
    absolute,
    format,
    maxBytes,
    maxPages,
    pagesFrom,
    pagesTo,
    sheets,
    pageSeparators,
    includeTables,
  };
}

function parsePositiveInt(
  raw: unknown,
  fallback: number,
  field: string,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `os.fs.read_document: \`${field}\` must be a positive number`,
    );
  }
  return Math.floor(raw);
}

function parseOptionalPositiveInt(
  raw: unknown,
  field: string,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `os.fs.read_document: \`${field}\` must be a positive number`,
    );
  }
  return Math.floor(raw);
}

function parseSheetsArg(
  raw: unknown,
): readonly (string | number)[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      "os.fs.read_document: `sheets` must be an array of strings or 1-indexed numbers",
    );
  }
  const out: (string | number)[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(entry);
    } else if (
      typeof entry === "number" &&
      Number.isFinite(entry) &&
      entry >= 1
    ) {
      out.push(Math.floor(entry));
    } else {
      throw new Error(
        `os.fs.read_document: invalid sheet identifier ${JSON.stringify(entry)}`,
      );
    }
  }
  return out;
}

/**
 * Extensions that are almost certainly source code or other line-oriented
 * text. They are deliberately NOT mapped to `plain`: `os.fs.read` is the
 * right tool for them (offset/limit pagination, `lineNumbers`, no document
 * extractor in the way). The set exists only so the rejection can say which
 * tool to reach for next — without that, models retry `read_document` with
 * an invented `format: "text"` and burn another step before discovering
 * `os.fs.read` (issue #113).
 */
const SOURCE_LIKE_EXTENSIONS: ReadonlySet<string> = new Set([
  "bash", "c", "cc", "cfg", "cjs", "clj", "conf", "cpp", "cs", "css", "cxx",
  "dart", "env", "erl", "ex", "exs", "fish", "go", "gradle", "h", "hh", "hpp",
  "hs", "ini", "ipynb", "java", "js", "jsonc", "jsx", "kt", "kts", "less",
  "lua", "m", "mjs", "mm", "php", "pl", "pm", "properties", "proto", "ps1",
  "py", "pyi", "r", "rb", "rs", "sass", "scala", "scss", "sh", "sql", "svelte",
  "swift", "tf", "toml", "ts", "tsv", "tsx", "vue", "zsh",
]);

/**
 * Resolve extension → canonical format. `.html/.xml/.json/.csv` currently
 * fall through to `plain` — it's the safest default until we need format-
 * specific pretty-printing for them.
 */
function detectFormat(absolute: string, override: unknown): DocumentFormat {
  if (typeof override === "string" && override.length > 0) {
    const norm = override.toLowerCase();
    if (isKnownFormat(norm)) return norm;
    throw new Error(
      `os.fs.read_document: unknown format override ${JSON.stringify(override)}`,
    );
  }
  const ext = extname(absolute).toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "doc":
      return "doc";
    case "xlsx":
      return "xlsx";
    case "rtf":
      return "rtf";
    case "odt":
      return "odt";
    case "pptx":
      return "pptx";
    case "":
    case "txt":
    case "md":
    case "log":
    case "csv":
    case "json":
    case "html":
    case "xml":
    case "yaml":
    case "yml":
      return "plain";
    default:
      // Two shapes on purpose: for a source-like extension the answer is
      // almost always "wrong tool", so name os.fs.read first and mention the
      // override second; for anything else the extension carries no signal,
      // so offer both. Either way the message spells out the accepted value
      // `format: "plain"` — the bare word `format` invited `format: "text"`,
      // which is not a known format and costs another failed step.
      throw new Error(
        SOURCE_LIKE_EXTENSIONS.has(ext)
          ? `os.fs.read_document: ".${ext}" is a source/text file — use os.fs.read instead; if you intended document extraction, retry with \`format: "plain"\``
          : `os.fs.read_document: unsupported extension ".${ext}" — use os.fs.read for source or text files, or retry with an explicit format (e.g. \`format: "plain"\`)`,
      );
  }
}

function isKnownFormat(value: string): value is DocumentFormat {
  return (
    value === "pdf" ||
    value === "docx" ||
    value === "doc" ||
    value === "xlsx" ||
    value === "rtf" ||
    value === "odt" ||
    value === "pptx" ||
    value === "plain"
  );
}

/**
 * Lazy-load the concrete extractor implementation so the dispatcher (and
 * its tests) do not pull in 3 MB of PDF/XLSX runtime until a real document
 * request arrives.
 */
async function resolveExtractor(
  format: DocumentFormat,
  options: ReadDocumentOptions,
): Promise<Extractor> {
  const injected = options.extractors?.[format];
  if (injected) return injected;
  switch (format) {
    case "pdf":
      return (await import("./extractors/pdf-extractor.js")).pdfExtractor;
    case "docx":
      return (await import("./extractors/docx-extractor.js")).docxExtractor;
    case "doc":
      return (await import("./extractors/doc-extractor.js")).docExtractor;
    case "xlsx":
      return (await import("./extractors/xlsx-extractor.js")).xlsxExtractor;
    case "rtf":
      return (await import("./extractors/rtf-extractor.js")).rtfExtractor;
    case "odt":
      return (await import("./extractors/odt-extractor.js")).odtExtractor;
    case "pptx":
      return (await import("./extractors/pptx-extractor.js")).pptxExtractor;
    case "plain":
      return (await import("./extractors/plain-text-extractor.js"))
        .plainTextExtractor;
  }
}

function capText(
  text: string,
  maxBytes: number,
): { text: string; bytesTruncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text, bytesTruncated: false };
  }
  // Slice by byte length, then trim to the nearest valid UTF-8 boundary to
  // avoid a stray replacement character at the cut point.
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  const safe = sliced.endsWith("\uFFFD") ? sliced.slice(0, -1) : sliced;
  return { text: safe, bytesTruncated: true };
}
