/**
 * A model server that turned a completion down because of its GBNF
 * grammar (ATO-1675). A leaf with no imports, so the llama-server client
 * and its tests can read it without a cycle.
 *
 * llama.cpp answers a grammar its parser cannot read with HTTP 400 and
 * `{"error":{"code":400,"message":"Failed to parse grammar","type":
 * "invalid_request_error"}}`. Our grammars use features older parsers do
 * not have (the `x{m,n}` repetition operator, repetition bounds near
 * `MAX_REPETITION_THRESHOLD`, see `reasoning-prelude.ts`), and the
 * servers that still listen on 8080 are exactly those older builds and
 * the Docker images (`config/docs/compatibility.md`). An older build
 * sends the same body as an SSE error event when the request streams.
 * Other OpenAI-shaped servers on `/completion` that validate their
 * fields name the field ("grammar ... not permitted / not supported").
 *
 * So a 400 whose words name the grammar is a refusal of the grammar,
 * never of the prompt. A context overflow carries its own type and is
 * never read as one, whatever its wording.
 */

/** The server's words name the grammar. */
const GRAMMAR_WORDING = /\bgrammars?\b/i;

/** llama.cpp's `error.type` for a prompt longer than the context window. */
const EXCEED_CONTEXT_SIZE_TYPE = "exceed_context_size_error";

/**
 * True for a 400 whose message names the grammar. `message` is the
 * client's error message, the server's own detail folded in
 * (`llama-server returned http 400: Failed to parse grammar`). `type` is
 * the body's `error.type`, when it sent one.
 */
export function isGrammarRefusal(
  status: number | null,
  message: string,
  type?: string,
): boolean {
  if (status !== 400) return false;
  if (type === EXCEED_CONTEXT_SIZE_TYPE) return false;
  return GRAMMAR_WORDING.test(message);
}
