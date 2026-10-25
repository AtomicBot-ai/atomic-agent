import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { retainToolOutput } from "../compressor/result-compressor.js";
import { readMoveAliases } from "./os/fs/fs-move-aliases.js";

/**
 * Argument shapes a tool reads as its canonical form, with the one-line
 * note its result carries so the model learns the real keys.
 *
 * Applied in two places that must agree: `findUnknownArguments` checks
 * the keys of the canonical form (an alias the tool reads is not an
 * unknown key, one it does not read still is), and `ToolRegistry.invoke`
 * hands the canonical form to the tool and prepends the note to its
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

const READERS: ReadonlyMap<
  string,
  (args: Record<string, unknown>) => ArgumentAliasReading | null
> = new Map([["os.fs.move", (args: Record<string, unknown>) => readMoveAliases(args)]]);

/** `args` in `tool`'s canonical form, or `null` when no alias applies. */
export function readArgumentAliases(
  tool: string,
  args: Record<string, unknown>,
): ArgumentAliasReading | null {
  return READERS.get(tool)?.(args) ?? null;
}

/** `result` with the alias note as its first line, in the full copy too. */
export function withAliasNote(
  result: CompressedToolResult,
  note: string,
): CompressedToolResult {
  const prefix = `${note}\n`;
  return retainToolOutput(
    result,
    { ...result, summary: `${prefix}${result.summary}` },
    { prefix },
  );
}
