/**
 * Minimal templater for webhook `userMessageTemplate` strings. Supports
 * `{{body.<json.path>}}` placeholders against a parsed JSON body —
 * deliberately narrow so the templating layer never pulls in a
 * general-purpose expression evaluator (security, dependency, and
 * grammar-safety reasons all point the same way).
 *
 * Unknown paths substitute to an empty string; callers that need a
 * stricter contract should validate `body` upstream. Escape literal
 * `{{` with a double-backslash prefix: `\\{{not a placeholder}}`.
 */
export function renderWebhookTemplate(
  template: string,
  body: unknown,
): string {
  return template.replace(
    /\\\{\{|\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (match, path: string | undefined) => {
      if (match.startsWith("\\")) return match.slice(1);
      if (!path) return "";
      return renderPath(path, body);
    },
  );
}

function renderPath(path: string, body: unknown): string {
  const segments = path.split(".");
  if (segments.length === 0) return "";
  const head = segments[0];
  if (head !== "body") return "";
  let cursor: unknown = body;
  for (let i = 1; i < segments.length; i++) {
    if (cursor === null || cursor === undefined) return "";
    if (typeof cursor !== "object") return "";
    const segment = segments[i];
    if (segment === undefined) return "";
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") {
    return String(cursor);
  }
  return JSON.stringify(cursor);
}
