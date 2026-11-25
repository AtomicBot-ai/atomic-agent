import { ConfigValidationError } from "../config-validation-error.js";
import {
  loraAdapterShapeProblem,
  type LoraAdapter,
} from "../../local-llm/server/lora-adapter.js";

/**
 * Parse `localModels.managed.loraAdapters` (ATO-1106): an object keyed by
 * local model id, each value `{ path, scale? }`. Absent / `null` returns
 * `undefined` so a file without the key reads exactly as before. Only the
 * shape is checked here; whether the file exists is checked at launch, so
 * an adapter on a drive that is not mounted does not stop config loading.
 */
export function parseLoraAdapters(
  raw: unknown,
  field: string,
  pathIsAbsolute?: (p: string) => boolean,
): Record<string, LoraAdapter> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, `expected an object keyed by model id, got ${JSON.stringify(raw)}`);
  }
  const result: Record<string, LoraAdapter> = {};
  for (const [modelId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const entryField = `${field}[${JSON.stringify(modelId)}]`;
    if (modelId.length === 0) throw new ConfigValidationError(field, "expected a non-empty model id key");
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigValidationError(entryField, `expected { path, scale? }, got ${JSON.stringify(entry)}`);
    }
    const { path, scale } = entry as { path?: unknown; scale?: unknown };
    if (typeof path !== "string") {
      throw new ConfigValidationError(`${entryField}.path`, `expected a string, got ${JSON.stringify(path)}`);
    }
    if (scale !== undefined && typeof scale !== "number") {
      throw new ConfigValidationError(`${entryField}.scale`, `expected a number, got ${JSON.stringify(scale)}`);
    }
    const adapter: LoraAdapter = scale === undefined ? { path } : { path, scale };
    const problem = loraAdapterShapeProblem(adapter, pathIsAbsolute);
    if (problem) throw new ConfigValidationError(entryField, problem);
    result[modelId] = adapter;
  }
  return result;
}
