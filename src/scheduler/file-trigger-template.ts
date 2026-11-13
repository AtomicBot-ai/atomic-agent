/**
 * Fills a file trigger's `userMessageTemplate` (ATO-441). Same narrow
 * grammar as the webhook templater: `{{name}}` placeholders from a fixed
 * set, unknown ones become an empty string, and `\{{` is a literal `{{`.
 */
export interface FileTriggerTemplateVars {
  /** Absolute path of the file that fired. */
  path: string;
  /** Path relative to the watched folder (the file name for a file trigger). */
  relativePath: string;
  /** The file's base name. */
  name: string;
  /** `add` or `change`. */
  event: string;
  /** The trigger's name in config. */
  trigger: string;
  /** Matching new lines, one per line; empty without `contains`. */
  lines: string;
}

export function renderFileTriggerTemplate(
  template: string,
  vars: FileTriggerTemplateVars,
): string {
  return template.replace(
    /\\\{\{|\{\{\s*([a-zA-Z]+)\s*\}\}/g,
    (match, key: string | undefined) => {
      if (match.startsWith("\\")) return match.slice(1);
      if (!key || !Object.prototype.hasOwnProperty.call(vars, key)) return "";
      return vars[key as keyof FileTriggerTemplateVars];
    },
  );
}
