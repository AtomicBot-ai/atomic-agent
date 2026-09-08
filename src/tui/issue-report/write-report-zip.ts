/**
 * The zip that accompanies a report: the same markdown GitHub gets, the
 * level-filtered snapshot, and every session trace the level admits.
 *
 * Written *before* the operator confirms, to the same folder `/dump`
 * uses, so "what exactly is about to leave this machine" has an answer
 * they can open — and so a report too big for GitHub's inline limits
 * still has a home they can drag into the issue by hand.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

import { traceFilePath } from "../../tracing/trace/trace-sink.js";
import { debugBundleTimestamp } from "../debug-bundle/build-snapshot.js";
import type { IssueReport } from "./build-issue-report.js";
import { renderSection, type ReportSection } from "./issue-body.js";
import type { RedactionContext } from "./redact.js";
import { redactTraceNdjson, type TraceRedactionStats } from "./trace-redaction.js";

export interface WriteReportZipOptions {
  report: IssueReport;
  traceDir: string;
  sessionIds: readonly string[];
  outDir: string;
  redaction: RedactionContext;
  now?: Date;
}

export interface WriteReportZipResult {
  path: string;
  bytes: number;
  /** Trace sections to append to the issue, one per session that had rows. */
  traceSections: ReportSection[];
  traces: Array<{ sessionId: string; included: boolean; stats?: TraceRedactionStats; reason?: string }>;
}

export function reportZipFileName(level: string, now: Date = new Date()): string {
  return `atomic-agent-report-${debugBundleTimestamp(now)}-${level}.zip`;
}

/** Inline trace text per session is capped so one huge session cannot eat every page. */
const MAX_INLINE_TRACE_CHARS = 60_000;

export async function writeReportZip(
  options: WriteReportZipOptions,
): Promise<WriteReportZipResult> {
  const { report } = options;
  const zip = new JSZip();
  const traceSections: ReportSection[] = [];
  const traces: WriteReportZipResult["traces"] = [];

  for (const sessionId of options.sessionIds) {
    const path = traceFilePath(options.traceDir, sessionId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      traces.push({
        sessionId,
        included: false,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const { text, stats } = redactTraceNdjson(raw, report.level, options.redaction);
    traces.push({ sessionId, included: true, stats });
    if (text.length === 0) continue;
    zip.file(`traces/${sessionId}.ndjson`, text);
    traceSections.push({
      title: `Trace ${sessionId} (${stats.kept} rows kept, ${stats.dropped} dropped, ${stats.stripped} fields removed)`,
      body: text.length > MAX_INLINE_TRACE_CHARS
        ? text.slice(text.length - MAX_INLINE_TRACE_CHARS)
        : text,
      fenced: true,
      lang: "json",
      collapsed: true,
    });
  }

  const markdown = [
    `# ${report.title}`,
    "",
    report.header,
    "",
    ...report.sections.map(renderSection),
    ...traceSections.map(renderSection),
  ].join("\n\n");
  zip.file("report.md", markdown);
  zip.file("snapshot.json", JSON.stringify({ ...report.snapshot, traces }, null, 2));

  const payload = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await mkdir(options.outDir, { recursive: true });
  const path = join(options.outDir, reportZipFileName(report.level, options.now));
  await writeFile(path, payload);
  return { path, bytes: payload.byteLength, traceSections, traces };
}
