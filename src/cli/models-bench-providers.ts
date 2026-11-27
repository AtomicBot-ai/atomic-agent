// Moved to the llm layer (ATO-2432) so the runtime's model council builds the
// same providers; kept here so the CLI commands and their tests import as before.
export {
  buildSpecProviders,
  closeSpecProviders,
  entryForSpec,
  parseModelSpecs,
  type BuiltSpecs,
  type ModelSpec,
} from "../llm/toolcall-bench/spec-providers.js";
