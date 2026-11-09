import type { CompressedToolResult } from "../compressor/result-compressor.js";

/**
 * Per-tool readers behind the task run summary (ATO-964). Each reads
 * the structured `details` a tool already returns, never the model's
 * prose, so the card says what the harness saw: which files the turn
 * wrote, which commands it ran and how they exited, which approvals
 * stopped it. Pure; the collector in [task-run-summary.ts](task-run-summary.ts)
 * owns the accumulation and the caps.
 */

/** How the file was changed; drives the wording of the card line. */
export type FileChangeKind = "created" | "edited" | "rewritten" | "appended";

export interface FileChangeObservation {
  path: string;
  kind: FileChangeKind;
  added: number;
  removed: number;
  /**
   * The counts come from a clipped diff, or from a whole-file rewrite
   * where the line counts before and after are all the tool knows.
   */
  approximate: boolean;
}

export interface CommandObservation {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  test: boolean;
}

export interface ApprovalObservation {
  tool: string;
  /**
   * `true`: a person was asked and said no. `false`: the gate refused
   * without a decision (nobody answered, the prompt could not be
   * delivered, a refuse policy), which an unattended run needs a
   * person for.
   */
  byUser: boolean;
}

/** Longest command line the card keeps; the rest is cut with "…". */
export const COMMAND_PREVIEW_MAX_CHARS = 120;

/**
 * Test runners recognised in a command line. Matching is on the
 * command the harness ran, so "tests passed" means a test command
 * exited 0, nothing more.
 */
const TEST_COMMAND =
  /\b(vitest|jest|pytest|mocha|phpunit|rspec|ctest)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|deno|dotnet|swift)\s+test\b|\bmake\s+(test|check)\b|\bpython3?\s+-m\s+(pytest|unittest)\b/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/** A file write or edit that landed, with its line counts. */
export function readFileChanges(
  result: CompressedToolResult,
): FileChangeObservation[] {
  if (result.status !== "ok") return [];
  const d = result.details;
  if (result.tool === "os.fs.write") {
    const path = stringField(d.path);
    if (path === null) return [];
    const lines = numberField(d.lines) ?? 0;
    if (d.mode === "append") {
      return [{ path, kind: "appended", added: lines, removed: 0, approximate: false }];
    }
    if (d.existed !== true) {
      return [{ path, kind: "created", added: lines, removed: 0, approximate: false }];
    }
    return [
      {
        path,
        kind: "rewritten",
        added: lines,
        removed: numberField(d.previousLines) ?? 0,
        approximate: true,
      },
    ];
  }
  if (result.tool === "os.fs.edit") {
    const path = stringField(d.path);
    if (path === null) return [];
    const diff = result.fullOutput ?? result.summary;
    const counts = countDiffLines(diff);
    return [
      {
        path,
        kind: "edited",
        added: counts.added,
        removed: counts.removed,
        approximate: result.truncated || diff.includes("[diff truncated]"),
      },
    ];
  }
  if (result.tool === "os.fs.patch" && Array.isArray(d.files)) {
    const out: FileChangeObservation[] = [];
    for (const file of d.files as unknown[]) {
      if (typeof file !== "object" || file === null) continue;
      const f = file as Record<string, unknown>;
      if (f.applied !== true) continue;
      const path = stringField(f.absolute) ?? stringField(f.path);
      if (path === null) continue;
      out.push({
        path,
        kind: "edited",
        added: numberField(f.addedLines) ?? 0,
        removed: numberField(f.removedLines) ?? 0,
        approximate: false,
      });
    }
    return out;
  }
  return [];
}

/** A shell command that ran to an exit (or its timeout). */
export function readCommand(
  result: CompressedToolResult,
): CommandObservation | null {
  if (result.tool !== "os.shell.run") return null;
  const d = result.details;
  if (!("exitCode" in d)) return null; // still running / never started
  const cmd = stringField(d.cmd);
  if (cmd === null) return null;
  const args = Array.isArray(d.args)
    ? (d.args as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const command = clip([cmd, ...args].join(" "), COMMAND_PREVIEW_MAX_CHARS);
  return {
    command,
    exitCode: numberField(d.exitCode),
    timedOut: d.timedOut === true,
    test: isTestCommand(command),
  };
}

/** An approval that stopped a call, from the ledger or the gate. */
export function readApproval(
  result: CompressedToolResult,
): ApprovalObservation | null {
  if (result.approvals?.some((r) => r.verdict === "denied")) {
    return { tool: result.tool, byUser: true };
  }
  if (
    result.status === "error" &&
    (result.details.errorName === "ApprovalDeniedError" ||
      result.details.approvalDenied === true)
  ) {
    return { tool: result.tool, byUser: false };
  }
  return null;
}

/** `+` / `-` body lines of a unified diff; headers and hunks skipped. */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let out = "";
  for (const ch of flat) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
