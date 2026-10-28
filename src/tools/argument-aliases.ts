import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { readMoveAliases } from "./os/fs/fs-move-aliases.js";
import { readShellAliases } from "./os/shell/shell-aliases.js";

/**
 * Argument shapes a tool reads as its canonical form, with the one-line
 * note its result carries so the model learns the real keys.
 *
 * Applied in two places that must agree: `findUnknownArguments` checks
 * the keys of the canonical form (an alias the tool reads is not an
 * unknown key, one it does not read still is), and `ToolRegistry.invoke`
 * hands the canonical form to the tool and appends the note to its
 * result. Rewriting at the registry, not inside the tool, means every
 * wrapper around the tool sees the canonical keys too — the read-scope
 * check reads `os.fs.move`'s `from`, and a source sent as `paths` must
 * not slip past it.
 *
 * Keep this short: an alias earns a place only when small models send
 * it and do not recover from the refusal. The schema shown to the model
 * stays canonical.
 */
export interface ArgumentAliasReading {
  readonly args: Record<string, unknown>;
  readonly note: string;
}

export interface ArgumentAliasOptions {
  /**
   * Whether a path argument, as sent (relative to the working
   * directory), is an existing file. Only the registry has a working
   * directory to ask; every other reader leaves it out and gets the same
   * keys, at most a `to` spelled as a folder where the registry would
   * have found a file.
   */
  isFile?: (path: string) => boolean;
}

type AliasReader = (
  args: Record<string, unknown>,
  options: ArgumentAliasOptions,
) => ArgumentAliasReading | null;

const READERS: ReadonlyMap<string, AliasReader> = new Map<string, AliasReader>([
  ["os.fs.move", (args, options) => readMoveAliases(args, options)],
  ["os.shell.run", (args) => readShellAliases(args)],
]);

/**
 * `args` in `tool`'s canonical form, or `null` when no alias applies.
 * Readers of a recorded call (compaction, the pause digest, tool cards,
 * the tool log) go through this too: the transcript keeps the call as
 * the model sent it, so what the model sees of its own history does not
 * change, and each reader sees what the tool ran.
 */
export function readArgumentAliases(
  tool: string,
  args: Record<string, unknown>,
  options: ArgumentAliasOptions = {},
): ArgumentAliasReading | null {
  return READERS.get(tool)?.(args, options) ?? null;
}

/** `args` as the tool read them: the alias reading, else `args` itself. */
export function canonicalArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return readArgumentAliases(tool, args)?.args ?? args;
}

/**
 * `result` with the alias note as its LAST line, in the full copy too.
 * Last, not first: the first line is the outcome or the error, and the
 * tool log and compaction take it as the call's reason.
 */
export function withAliasNote(
  result: CompressedToolResult,
  note: string,
): CompressedToolResult {
  const noted: CompressedToolResult = {
    ...result,
    summary: `${result.summary}\n${note}`,
  };
  // The uncompressed copy is non-enumerable and the spread drops it.
  if (result.fullOutput !== undefined) {
    Object.defineProperty(noted, "fullOutput", { value: `${result.fullOutput}\n${note}`, enumerable: false });
    Object.defineProperty(noted, "fullOutputTruncated", { value: result.fullOutputTruncated, enumerable: false });
  }
  return noted;
}
