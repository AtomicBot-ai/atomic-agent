import {
  resolveClaudeCodeOptions,
  resolveCodexOptions,
  resolveOpenclawOptions,
  resolveSelectedOptions,
} from "../../import/index.js";
import type { ImportFormState } from "./import-panel-state.js";
import { importSourceToggles } from "./import-sources.js";

/**
 * Turn the Import tab's form into the option list its source's importer
 * takes. Each source keeps its own resolver (they differ in presets and
 * in what `secrets` means), so the form is translated into the shape
 * every resolver shares: an `exclude` list of the toggles switched off,
 * plus the explicit secrets opt-in. Returns an empty list when nothing
 * is ticked; the orchestrator turns that into the notice.
 */
export function resolveImportFormOptions(form: ImportFormState): string[] {
  const exclude = importSourceToggles(form.source)
    .map((meta) => meta.id)
    .filter((id) => id !== "secrets" && !form[id]);
  switch (form.source) {
    case "hermes":
      return resolveSelectedOptions({
        preset: "default",
        exclude,
        migrateSecrets: form.secrets,
      });
    case "openclaw":
      return resolveOpenclawOptions({ exclude });
    case "claude-code":
      return resolveClaudeCodeOptions({
        exclude,
        migrateSecrets: form.secrets,
      });
    case "codex":
      return resolveCodexOptions({ exclude, migrateSecrets: form.secrets });
  }
}

/** The notice shown when the form has nothing ticked for its source. */
export function nothingSelectedNotice(form: ImportFormState): string {
  const names = importSourceToggles(form.source).map((meta) => meta.id);
  const last = names.pop();
  const list = names.length > 0 ? `${names.join(", ")} or ${last}` : last;
  return `nothing selected to import — enable ${list}`;
}
