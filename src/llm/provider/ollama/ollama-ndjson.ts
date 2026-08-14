import { OpenAiHttpError } from "../openai/openai-http.js";
import type { OllamaChatChunk } from "./ollama-normalise-response.js";

/**
 * Parse Ollama's native streaming format: newline-delimited JSON, one
 * complete object per line, terminated by a chunk with `done: true`.
 *
 * Two properties of this format shape the consumer:
 *
 *  - A mid-stream failure arrives as an `{ "error": ... }` line with
 *    the HTTP status already sent as 200, so every parsed line must be
 *    checked for `error` — the status code alone proves nothing.
 *  - Tool calls are emitted whole in a single chunk (the server buffers
 *    until the arguments parse as complete JSON), so no fragment
 *    accumulation is needed here, unlike the OpenAI delta format.
 */
export async function* consumeOllamaNdjson(
  body: ReadableStream<Uint8Array>,
  url: string,
  label: string,
  signal?: AbortSignal,
): AsyncGenerator<OllamaChatChunk, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          yield parseOllamaLine(line, url, label);
        }
        newline = buffered.indexOf("\n");
      }
    }
    const tail = buffered.trim();
    if (tail.length > 0) {
      yield parseOllamaLine(tail, url, label);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseOllamaLine(
  line: string,
  url: string,
  label: string,
): OllamaChatChunk {
  let parsed: OllamaChatChunk;
  try {
    parsed = JSON.parse(line) as OllamaChatChunk;
  } catch {
    throw new OpenAiHttpError(
      `ollama stream sent a malformed line: ${line.slice(0, 200)}`,
      null,
      url,
      false,
      null,
      label,
    );
  }
  if (typeof parsed.error === "string" && parsed.error.length > 0) {
    throw new OpenAiHttpError(
      `ollama stream error: ${parsed.error.slice(0, 300)}`,
      null,
      url,
      false,
      null,
      label,
    );
  }
  return parsed;
}

function abortError(): Error {
  const err = new Error("completion aborted by caller");
  err.name = "AbortError";
  return err;
}
