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

const TRAILING_JSON_RE = /(\{[\s\S]*\})\s*$/;

export function parseCliOutput(stdout: string, stderr: string): ParsedCliOutput {
  const reply = stdout.trim();
  const tail = stderr.trim();
  const match = tail.match(TRAILING_JSON_RE);
  const jsonBlob = match?.[1];
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
