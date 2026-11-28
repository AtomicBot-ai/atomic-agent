/**
 * ATO-2448: the Codex part of `atag launch --config`, an `atomic` model
 * provider in `~/.codex/config.toml`. Without a TOML library the edit is
 * text: two marked blocks, one at the top (`model_provider`, `model`: keys
 * that must come before the first table) and the provider table at the
 * end. A top-level `model_provider` or `model` the person already had is
 * commented out with a marker. `--revert` deletes the blocks and restores
 * those lines, and touches nothing else in the file.
 */

export const TOML_BLOCK_START = "# >>> atomic-agent launch (atag launch codex --revert removes this) >>>";
export const TOML_BLOCK_END = "# <<< atomic-agent launch <<<";
/** Prefix of a line this edit commented out. */
export const TOML_DISABLED = "# atomic-agent launch disabled: ";

const KEYS_WE_SET = /^\s*(model_provider|model)\s*=/;
const TABLE_HEADER = /^\s*\[/;

export interface CodexTomlSettings {
  /** Value of `[model_providers.atomic]` keys and the top-level ones, already TOML-quoted. */
  readonly topLevel: readonly string[];
  readonly table: readonly string[];
}

/** Whether the file has a provider table of the same name that is not ours. */
export function hasForeignAtomicProvider(text: string): boolean {
  return withoutOurEdits(text).split(/\r?\n/).some((line) => /^\s*\[model_providers\.atomic\]\s*$/.test(line));
}

/** The file with our blocks and markers taken out. */
export function withoutOurEdits(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === TOML_BLOCK_START) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line === TOML_BLOCK_END) inBlock = false;
      continue;
    }
    out.push(line.startsWith(TOML_DISABLED) ? line.slice(TOML_DISABLED.length) : line);
  }
  // The blank line and final newline our blocks added go too.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length === 0 ? "" : `${out.join(eol)}${eol}`;
}

/** The file with our settings; earlier ones of ours are replaced, not stacked. */
export function withOurEdits(text: string, settings: CodexTomlSettings): string {
  const clean = withoutOurEdits(text);
  const eol = clean.includes("\r\n") ? "\r\n" : "\n";
  const lines = clean === "" ? [] : clean.split(/\r?\n/);
  let inTopLevel = true;
  const body = lines.map((line) => {
    if (TABLE_HEADER.test(line)) inTopLevel = false;
    return inTopLevel && KEYS_WE_SET.test(line) ? `${TOML_DISABLED}${line}` : line;
  });
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  const top = [TOML_BLOCK_START, ...settings.topLevel, TOML_BLOCK_END];
  const table = [TOML_BLOCK_START, ...settings.table, TOML_BLOCK_END];
  return [...top, ...body, ...(body.length > 0 ? [""] : []), ...table, ""].join(eol);
}
