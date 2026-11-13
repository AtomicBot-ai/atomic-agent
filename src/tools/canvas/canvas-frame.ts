import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { CHART_TYPES, type ChartType } from "./canvas-chart.js";
import { CANVAS_DETAIL, CANVAS_RENDER_TOOL, type CanvasRecord } from "./canvas-render.js";

/**
 * The canvas an ok `canvas.render` call wrote (ATO-1137), for a host to
 * show in the chat: `{path, title, kind, chart?, bytes}`. The live
 * stream is the only path to it (the summary is clipped and the session
 * store keeps no `details`), so the SSE `tool_result` frame and the
 * sidecar's `tool_call_result` carry it as `canvas`. Undefined for any
 * other call, a failed one, or a shape a host could not open.
 */
export function canvasRecordOf(result: CompressedToolResult): CanvasRecord | undefined {
  if (result.tool !== CANVAS_RENDER_TOOL || result.status !== "ok") return undefined;
  const raw = (result.details ?? {})[CANVAS_DETAIL];
  if (typeof raw !== "object" || raw === null) return undefined;
  const { path, title, kind, chart, bytes } = raw as Record<string, unknown>;
  if (typeof path !== "string" || path.length === 0 || typeof title !== "string") return undefined;
  if (kind !== "html" && kind !== "chart") return undefined;
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
  const chartType = typeof chart === "string" && (CHART_TYPES as readonly string[]).includes(chart) ? (chart as ChartType) : undefined;
  return { path, title, kind, ...(kind === "chart" && chartType !== undefined ? { chart: chartType } : {}), bytes };
}
