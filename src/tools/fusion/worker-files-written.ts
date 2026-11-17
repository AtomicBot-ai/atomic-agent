import { FILE_WRITING_TOOLS } from "./worker-result.js";

/**
 * How many files one worker has written so far, for its live row
 * (ATO-1364).
 *
 * Distinct files, not write calls: a worker that edits the same module
 * nine times has touched one file, and "9 files" on its row would send
 * the operator looking for eight that do not exist. The path comes from
 * the call's own args (`tool_call_parsed`), paired with its result
 * (`tool_call_executed`) by the batch index both carry; only a call that
 * came back `ok` counts.
 *
 * `os.fs.patch` writes only with `apply: true` (the default is a dry
 * run); its files are read off the inline diff's `+++` headers. A patch
 * read from `patchPath`, or any write whose args name no path, counts as
 * one file of its own — the honest lower bound, since the row cannot
 * see inside it.
 */
export class WrittenFilesTracker {
  private readonly pending = new Map<number, readonly string[] | null>();
  private readonly paths = new Set<string>();
  private unnamed = 0;

  /** Remember which files a call is about to write, if it is a write. */
  observeParsed(
    call: { tool: string; args: Record<string, unknown> },
    batchIndex: number,
  ): void {
    if (!FILE_WRITING_TOOLS.has(call.tool)) {
      this.pending.delete(batchIndex);
      return;
    }
    if (call.tool === "os.fs.patch" && call.args.apply !== true) {
      this.pending.delete(batchIndex);
      return;
    }
    this.pending.set(batchIndex, targetsOf(call.tool, call.args));
  }

  /** Count the call's files if it succeeded. True when the count moved. */
  observeExecuted(
    result: { tool: string; status: string },
    batchIndex: number,
  ): boolean {
    if (!this.pending.has(batchIndex)) return false;
    const targets = this.pending.get(batchIndex) ?? null;
    this.pending.delete(batchIndex);
    if (result.status !== "ok" || !FILE_WRITING_TOOLS.has(result.tool)) {
      return false;
    }
    const before = this.count;
    if (targets === null || targets.length === 0) {
      this.unnamed += 1;
    } else {
      for (const path of targets) this.paths.add(path);
    }
    return this.count !== before;
  }

  get count(): number {
    return this.paths.size + this.unnamed;
  }
}

function targetsOf(
  tool: string,
  args: Record<string, unknown>,
): readonly string[] | null {
  if (tool === "os.fs.patch") {
    return typeof args.patch === "string" ? patchTargets(args.patch) : null;
  }
  return typeof args.path === "string" && args.path.trim().length > 0
    ? [normalise(args.path)]
    : null;
}

/** `+++ b/src/a.ts` → `src/a.ts`; a deletion (`/dev/null`) writes no file. */
function patchTargets(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
    if (raw.length === 0 || raw === "/dev/null") continue;
    out.push(normalise(raw.replace(/^b\//, "")));
  }
  return out;
}

function normalise(path: string): string {
  return path.trim().replace(/^\.\//, "");
}
