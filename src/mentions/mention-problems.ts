/**
 * `@problems` as text (ATO-2472): what the language servers report for
 * the working folder (`collectWorkspaceProblems`), errors first, bounded.
 * The same text goes into the message block and back from
 * `GET /api/problems` for the desktop, so both surfaces say the same.
 */

import type { FileProblems, LspDiagnostic, WorkspaceProblems } from "../tools/os/fs/lsp/index.js";

/** Most problems listed; the rest are counted. */
export const MAX_LISTED_PROBLEMS = 100;
const MAX_MESSAGE_CHARS = 240;

export const NO_PROBLEMS_TEXT = "No problems found.";
export const LSP_OFF_TEXT =
  "No language server is running: language servers are off. Turn them on with "
  + "`atomic-agent config set tools.lsp.enabled true` to see problems here.";
export const NO_SERVER_TEXT =
  "No language server is running for this folder. Problems come from a language server "
  + "installed on this computer (typescript-language-server, pyright, gopls, rust-analyzer, "
  + "clangd and others) in a git checkout the agent may start one in.";

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function severityOf(d: LspDiagnostic): number {
  return d.severity === undefined ? 1 : d.severity;
}

function lineOf(path: string, d: LspDiagnostic): string {
  const line = (d.range?.start?.line ?? 0) + 1;
  const col = (d.range?.start?.character ?? 0) + 1;
  const first = d.message.trim().split("\n")[0] ?? "";
  const message = first.length > MAX_MESSAGE_CHARS ? `${first.slice(0, MAX_MESSAGE_CHARS - 1)}…` : first;
  const code = d.code === undefined || d.code === "" ? "" : ` [${d.source ? `${d.source} ` : ""}${d.code}]`;
  return `${path}:${line}:${col} ${SEVERITY[severityOf(d)] ?? "error"}${code} ${message}`;
}

/** Counts by severity: errors, warnings, the rest. */
export function countProblems(files: readonly FileProblems[]): { errors: number; warnings: number; other: number } {
  let errors = 0;
  let warnings = 0;
  let other = 0;
  for (const f of files) {
    for (const d of f.diagnostics) {
      const s = severityOf(d);
      if (s === 1) errors += 1;
      else if (s === 2) warnings += 1;
      else other += 1;
    }
  }
  return { errors, warnings, other };
}

/** The text one `@problems` inlines, or the plain sentence for an empty or missing source. */
export function formatProblems(result: WorkspaceProblems, max = MAX_LISTED_PROBLEMS): string {
  if (result.state === "off") return `${LSP_OFF_TEXT}\n`;
  if (result.state === "no_server") return `${NO_SERVER_TEXT}\n`;
  const all = result.files.flatMap((f) => f.diagnostics.map((d) => ({ path: f.path, d })));
  if (all.length === 0) return `${NO_PROBLEMS_TEXT} (checked by ${result.servers.join(", ")})\n`;
  all.sort((a, b) =>
    severityOf(a.d) - severityOf(b.d)
    || a.path.localeCompare(b.path)
    || (a.d.range?.start?.line ?? 0) - (b.d.range?.start?.line ?? 0));
  const { errors, warnings, other } = countProblems(result.files);
  const head = [`${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}`
    + (other > 0 ? `, ${other} other` : "")
    + ` in ${result.files.length} ${result.files.length === 1 ? "file" : "files"} (from ${result.servers.join(", ")})`];
  const shown = all.slice(0, max).map(({ path, d }) => lineOf(path, d));
  const more = all.length > shown.length ? [`… and ${all.length - shown.length} more`] : [];
  return `${[...head, ...shown, ...more].join("\n")}\n`;
}
