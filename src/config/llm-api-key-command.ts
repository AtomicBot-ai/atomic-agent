import { ConfigValidationError } from "./config-validation-error.js";

/**
 * `llm.providers[].apiKeyCommand`: argv of a command whose stdout is the
 * provider's key, for short-lived tokens (Vertex AI:
 * `["gcloud", "auth", "print-access-token"]`). An array, not a command
 * line: it runs without a shell, so there is nothing to quote or expand.
 * Absent (or `null`) means no command. Running it belongs to the request
 * path (`llm/provider/openai/api-key-command.ts`); config only validates.
 */
export function parseOptionalApiKeyCommand(
  raw: unknown,
  field: string,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigValidationError(field, "expected a non-empty array of strings");
  }
  return raw.map((part, i) => {
    if (typeof part !== "string" || part.length === 0) {
      throw new ConfigValidationError(`${field}[${i}]`, "expected non-empty string");
    }
    return part;
  });
}
