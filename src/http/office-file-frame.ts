import type { CompressedToolResult } from "../compressor/result-compressor.js";

/**
 * The Office writers (ATO-2518): their ok result carries `details.path`
 * (absolute) and `details.change`. `os.fs.xlsx op: read` writes nothing
 * and has no `change`, so it sends no frame.
 */
const OFFICE_WRITERS: ReadonlySet<string> = new Set([
  "os.fs.docx",
  "os.fs.xlsx",
  "os.fs.write_pptx",
]);

export interface OfficeFileFrame {
  path: string;
  change: "created" | "updated";
}

/**
 * `office_file` on a `tool_result` frame (ATO-2518): the file an ok Office
 * writer made or changed, `{path, change}`, for the desktop's "Changed
 * files" card. A .docx has no lines to count, so it gets no `diffstat`;
 * the desktop used to read the path from the `tool_progress` label, which
 * is the call's arguments clipped to 120 characters, so a call whose
 * blocks or slides came before `path` lost its row. The path here is the
 * one the tool wrote, already absolute. Left out for any other tool, a
 * failed call, or a shape a host cannot draw.
 */
export function officeFileFrame(result: CompressedToolResult): { office_file?: OfficeFileFrame } {
  if (!OFFICE_WRITERS.has(result.tool) || result.status !== "ok") return {};
  const details = result.details ?? {};
  const { path, change } = details as { path?: unknown; change?: unknown };
  if (typeof path !== "string" || path.length === 0) return {};
  if (change !== "created" && change !== "updated") return {};
  return { office_file: { path, change } };
}
