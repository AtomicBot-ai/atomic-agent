/**
 * `atomic-agent run` writes the assistant's reply to stdout and a
 * structured JSON blob to stderr after the chat loop exits, e.g.:
 *
 *   {"sessionId":"s-...","status":"completed","turnCount":1,...}
 *
 * The blob is the *last* JSON object on stderr. Parsing it gives us the
 * sessionId we need to locate the trace file. The reply is collected by
 * concatenating stdout (one line per assistant turn — for evals we feed
 * exactly one user message, so we expect at most one reply line).
 */

export interface ParsedCliOutput {
  reply: string;
  sessionId: string | null;
  sessionStatus: string | null;
  stepCount: number | null;
  lastError: string | null;
}

export function parseCliOutput(stdout: string, stderr: string): ParsedCliOutput {
  const reply = stdout.trim();
  const jsonBlob = findTrailingJsonBlock(stderr);
  if (!jsonBlob) {
    return {
      reply,
      sessionId: null,
      sessionStatus: null,
      stepCount: null,
      lastError: null,
    };
  }
  try {
    const parsed = JSON.parse(jsonBlob) as Record<string, unknown>;
    return {
      reply,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      sessionStatus: typeof parsed.status === "string" ? parsed.status : null,
      stepCount: typeof parsed.stepCount === "number" ? parsed.stepCount : null,
      lastError:
        parsed.lastError && typeof parsed.lastError === "object"
          ? JSON.stringify(parsed.lastError)
          : typeof parsed.lastError === "string"
            ? parsed.lastError
            : null,
    };
  } catch {
    return {
      reply,
      sessionId: null,
      sessionStatus: null,
      stepCount: null,
      lastError: null,
    };
  }
}

function findTrailingJsonBlock(stderr: string): string | null {
  const lines = stderr.trimEnd().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trimStart().startsWith("{") !== true) continue;
    const candidate = lines.slice(index).join("\n").trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning upward. Earlier log lines can contain inline JSON
      // fragments; only the final status object should parse by itself.
    }
  }
  return null;
}
