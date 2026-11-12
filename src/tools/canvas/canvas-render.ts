import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { CHART_TYPES, renderChartPage, renderHtmlPage, type ChartSeries, type ChartSpec, type ChartType } from "./canvas-chart.js";

export const CANVAS_RENDER_TOOL = "canvas.render";
/** Key of the canvas record in the result's `details`, read by `canvasFrameOf`. */
export const CANVAS_DETAIL = "canvas";

const TITLE_MAX_CHARS = 200;
const HTML_MAX_CHARS = 1_000_000;
const LABELS_MAX = 1_000;
const SERIES_MAX = 8;

/** What a host needs to show the canvas: where the file is and what it is. */
export interface CanvasRecord {
  /** Absolute path of the HTML file in the working folder. */
  path: string;
  title: string;
  kind: "html" | "chart";
  /** The chart type, for `kind: "chart"`. */
  chart?: ChartType;
  bytes: number;
}

export interface CanvasRenderToolOptions {
  /** Test seam: the time in the file name. */
  now?: () => Date;
}

type Parsed =
  | { title: string; subtitle?: string; name?: string; kind: "html"; html: string }
  | { title: string; subtitle?: string; name?: string; kind: "chart"; chart: ChartSpec };

function optionalString(raw: unknown, key: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error(`\`${key}\` must be a string`);
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function finiteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // Small models send numbers as strings ("1,200", "42%"); take the plain ones.
  if (typeof raw === "string" && /^\s*-?\d[\d,]*(\.\d+)?\s*%?\s*$/.test(raw)) {
    const n = Number(raw.replace(/[,%\s]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseValues(raw: unknown, where: string, length: number): number[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be an array of numbers`);
  if (raw.length !== length) throw new Error(`${where} has ${raw.length} values but there are ${length} labels; give one value per label`);
  return raw.map((v, i) => {
    const n = finiteNumber(v);
    if (n === undefined) throw new Error(`${where}[${i}] is ${JSON.stringify(v)}, not a number`);
    return n;
  });
}

function parseChart(raw: Record<string, unknown>, type: string): ChartSpec {
  const chart = type.trim().toLowerCase() as ChartType;
  if (!CHART_TYPES.includes(chart)) throw new Error(`\`chart\` "${type}" is not supported; use one of ${CHART_TYPES.join(", ")}`);
  if (!Array.isArray(raw.labels) || raw.labels.length === 0) throw new Error("`labels` must be a non-empty array: one label per data point (the x axis, or the pie slices)");
  if (raw.labels.length > LABELS_MAX) throw new Error(`at most ${LABELS_MAX} labels; aggregate the data first`);
  const labels = raw.labels.map((label) => (typeof label === "string" ? label : String(label)));
  let series: ChartSeries[];
  if (raw.series !== undefined && raw.series !== null) {
    if (!Array.isArray(raw.series) || raw.series.length === 0) throw new Error("`series` must be a non-empty array of { name, values }");
    if (raw.series.length > SERIES_MAX) throw new Error(`at most ${SERIES_MAX} series`);
    series = raw.series.map((item, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`series[${i}] must be { name, values }`);
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : `Series ${i + 1}`;
      return { name, values: parseValues(record.values, `series[${i}].values`, labels.length) };
    });
  } else if (raw.values !== undefined) {
    // One series, the shape a small model reaches for first.
    series = [{ name: "Value", values: parseValues(raw.values, "`values`", labels.length) }];
  } else {
    throw new Error("a chart needs its numbers: `series` [{ name, values }] or `values` (one number per label)");
  }
  return { type: chart, labels, series };
}

function parseArgs(raw: Record<string, unknown>): Parsed {
  const title = optionalString(raw.title, "title");
  if (title === undefined) throw new Error("`title` must be a non-empty string");
  if (title.length > TITLE_MAX_CHARS) throw new Error(`\`title\` is longer than ${TITLE_MAX_CHARS} characters`);
  const subtitle = optionalString(raw.subtitle, "subtitle");
  const name = optionalString(raw.name, "name");
  const base = { title, ...(subtitle !== undefined ? { subtitle } : {}), ...(name !== undefined ? { name } : {}) };
  const html = optionalString(raw.html, "html");
  const chart = optionalString(raw.chart, "chart");
  if (html !== undefined && chart !== undefined) throw new Error("pass either `html` or `chart` with its data, not both");
  if (html !== undefined) {
    if (html.length > HTML_MAX_CHARS) throw new Error(`\`html\` is longer than ${HTML_MAX_CHARS} characters`);
    return { ...base, kind: "html", html };
  }
  if (chart !== undefined) return { ...base, kind: "chart", chart: parseChart(raw, chart) };
  throw new Error(`pass \`html\` (a page or fragment you wrote) or \`chart\` (${CHART_TYPES.join("|")}) with \`labels\` and \`series\``);
}

/** `quarterly-revenue` from "Quarterly revenue (2026)": safe on every file system. */
export function canvasSlug(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "canvas";
}

/** `canvas-<slug>-20261112-142233.html`, then `-2`, `-3`: never an existing file. */
async function writeNewFile(workingDir: string, slug: string, now: Date, content: string): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let attempt = 1; ; attempt++) {
    const path = join(workingDir, `canvas-${slug}-${stamp}${attempt === 1 ? "" : `-${attempt}`}.html`);
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 50) throw err;
    }
  }
}

/**
 * `canvas.render { title, html? | chart + labels + series, subtitle?, name? }`
 * (ATO-1137): a chart or a page the model wrote, saved as one
 * self-contained HTML file in the session's working folder. The result
 * carries the file in `details.canvas`; the stream hands it to the host
 * as `canvas` on the call's `tool_result` frame, so the chat can show
 * the canvas the moment it is written.
 *
 * Always a new file (`wx`, never overwrites), only inside the working
 * folder, so it asks nothing, like `plan.update`; it is not read-only,
 * so plan mode does not run it.
 */
export function buildCanvasRenderTool(options: CanvasRenderToolOptions = {}): ToolDefinition {
  const now = options.now ?? (() => new Date());
  return {
    name: CANVAS_RENDER_TOOL,
    description:
      "Draw a chart (bar, line, area, pie, table) from data, or save an HTML page you wrote, as a self-contained HTML file in the working folder that the chat shows as a canvas.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: Parsed;
      try {
        args = parseArgs(rawArgs);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const page = args.kind === "html"
        ? renderHtmlPage(args.title, args.subtitle, args.html)
        : renderChartPage(args.title, args.subtitle, args.chart);
      let path: string;
      try {
        path = await writeNewFile(ctx.workingDir, canvasSlug(args.name ?? args.title), now(), page);
      } catch (err) {
        return errorResult(`could not write the canvas file: ${(err as Error).message}`);
      }
      const record: CanvasRecord = {
        path,
        title: args.title,
        kind: args.kind,
        ...(args.kind === "chart" ? { chart: args.chart.type } : {}),
        bytes: Buffer.byteLength(page, "utf8"),
      };
      const what = args.kind === "chart"
        ? `${args.chart.type} chart of ${args.chart.series.length === 1 ? "1 series" : `${args.chart.series.length} series`} over ${args.chart.labels.length} labels`
        : "HTML page";
      return compressToolResult(
        {
          tool: CANVAS_RENDER_TOOL,
          status: "ok",
          output: [
            `Saved canvas "${args.title}" (${what}) to ${path}`,
            "The chat shows it as a canvas. To also send it as a file (Telegram, Discord), pass this path in reply.attachments.",
          ].join("\n"),
          details: { [CANVAS_DETAIL]: record },
        },
        { maxSummaryLength: 2_000 },
      );
    },
  };
}

function errorResult(message: string): CompressedToolResult {
  return compressToolResult({
    tool: CANVAS_RENDER_TOOL,
    status: "error",
    output: `canvas.render: ${message}`,
  });
}
