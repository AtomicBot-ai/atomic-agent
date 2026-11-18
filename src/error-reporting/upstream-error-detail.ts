/**
 * What a provider said was wrong with a refused request, reduced to
 * values that cannot carry the user's text (ATO-1673).
 *
 * `upstream_error_type` says THAT a provider refused a turn
 * (`invalid_request_error` on ~600 events in two weeks, across DeepSeek,
 * Anthropic, Gemini and Atomic Chat) but never WHAT it refused: the
 * provider's sentence is the only place that says, and the sentence can
 * quote the user's prompt, a file path or a tool argument, so it never
 * leaves the machine. This module reads that sentence on the machine and
 * sends three bounded facts instead:
 *
 *  - `upstream_reason`: one word from the fixed {@link UpstreamReason}
 *    vocabulary, picked by matching the provider's wording against known
 *    refusal shapes (`missing_thought_signature`, `tool_result_missing`,
 *    `empty_content`, …), `other` when nothing matched. Only the word
 *    travels, never the text it was matched on.
 *  - `upstream_error_param`: the request field the provider blamed, from
 *    OpenAI's `error.param` or a field path at the head of the message
 *    (`messages.3.content.0.text`, `contents[3].parts[0]`). Kept only when
 *    it starts at a known request field. Every index becomes `[]`; below
 *    the root only the request's own structural words are kept, and the
 *    path is cut to `*` at the first other word and right after any map
 *    of chosen names (tool arguments, tool results, schema properties
 *    and definitions). A dotted word inside a file path or ending in a
 *    file extension is not read as a field. So neither a position in the
 *    conversation nor a tool's, schema's or user's own names travel.
 *  - `upstream_error_code`: `error.code` (`invalid_value`), or Google's
 *    `error.status` (`INVALID_ARGUMENT`) when the code is only a number,
 *    the same bounded enum shape as the type.
 *
 * The provider's full sentence stays where it already was: in the chat
 * row (`humanizeOpenAiHttpError` quotes it) and the local trace `error`
 * row, on this machine only.
 */

export type UpstreamReason =
  | "context_overflow"
  | "out_of_credit"
  | "missing_thought_signature"
  | "missing_reasoning_content"
  | "tool_result_missing"
  | "tool_result_orphan"
  | "tools_unsupported"
  | "tool_schema_invalid"
  | "tool_name_invalid"
  | "must_end_with_user"
  | "trailing_whitespace"
  | "roles_must_alternate"
  | "empty_content"
  | "reasoning_param"
  | "temperature"
  | "max_tokens"
  | "unsupported_parameter"
  | "image_unsupported"
  | "model_not_found"
  | "request_too_large"
  | "malformed_body"
  | "other";

export interface UpstreamErrorDetail {
  upstreamReason?: UpstreamReason;
  upstreamErrorParam?: string;
  upstreamErrorCode?: string;
}

/**
 * Known refusal wordings, most specific first: a body that names a
 * missing thought signature also says "function call", and one about an
 * empty tool result also says "content".
 */
const REASON_PATTERNS: ReadonlyArray<readonly [UpstreamReason, RegExp]> = [
  [
    "context_overflow",
    /exceed_context_size|context_length_exceeded|maximum context length|context[ _-]?(?:length|window|size)[^.]{0,60}(?:exceed|too (?:long|large|small)|maximum|limit)|exceeds? (?:the |its )?(?:available )?context|prompt is too long|too many tokens in (?:the )?prompt|input token count[^.]{0,40}exceeds/i,
  ],
  [
    "out_of_credit",
    /insufficient[ _-]?(?:balance|credits?|funds|quota)|credit balance|out of (?:credits?|funds)|requires more credits|payment[ _-]required|credit_balance_exhausted/i,
  ],
  ["missing_thought_signature", /thought[ _-]?signature/i],
  ["missing_reasoning_content", /reasoning_content/i],
  [
    "tool_result_missing",
    /tool_calls['"`]?\s+must be followed by tool|tool_use['"`]? ids? (?:were )?found without|without (?:a )?(?:corresponding )?tool_result|did not have response messages|number of function response parts/i,
  ],
  [
    "tool_result_orphan",
    /unexpected [`'"]?tool_use_id|tool_call_id[^.]{0,60}(?:not found|unexpected|invalid|does not match|no matching)|tool messages? must be a response to|preceding message with ['"`]?tool_calls|tool_result[^.]{0,40}(?:without|no) (?:corresponding|matching) tool_use/i,
  ],
  [
    "tools_unsupported",
    /does(?: not|n't) support (?:tools|tool[ _]?(?:calls?|use)|function[ _]calling)|(?:tools?|function calling) (?:is|are) not (?:supported|enabled)/i,
  ],
  [
    "tool_schema_invalid",
    /json[ _-]?schema|input_schema|function_declarations|invalid schema|schema[^.]{0,40}(?:invalid|not supported|unsupported)|unknown name "?\$|\$ref|\$defs|\.parameters\b/i,
  ],
  [
    "tool_name_invalid",
    /(?:function|tool)[ _.]name[^.]{0,60}(?:must|invalid|too long|match|pattern)|string too long[^.]{0,40}name/i,
  ],
  [
    "must_end_with_user",
    /(?:final|last) (?:message|turn)[^.]{0,40}(?:must|should) (?:be|come from) (?:a |the )?user|must end with a user|does(?: not|n't) support (?:assistant )?(?:message )?prefill/i,
  ],
  // Anthropic's "final assistant content cannot end with trailing
  // whitespace": a prefill that IS accepted, with a space at its end. Its
  // own word, not the prefill refusal above.
  ["trailing_whitespace", /trailing whitespace/i],
  [
    "roles_must_alternate",
    /roles? must alternate|alternate between (?:user|"user")|consecutive (?:user|assistant) messages|must start with a user|first message must/i,
  ],
  [
    "empty_content",
    /(?:must|should) (?:be )?non-?empty|empty (?:content|text|message|string)|(?:content|text|parts?)[^.]{0,30}(?:cannot|must not|should not|can't) be empty|is empty\b/i,
  ],
  [
    "reasoning_param",
    /reasoning_effort|\breasoning\b[^.]{0,30}(?:not supported|unsupported|invalid)|\bthinking\b[^.]{0,40}(?:not supported|unsupported|budget|must|requires|enabled)/i,
  ],
  ["temperature", /\btemperature\b|\btop_p\b/i],
  ["max_tokens", /max_(?:completion_|output_)?tokens/i],
  [
    "unsupported_parameter",
    /unsupported (?:parameter|value|argument|field)|unrecognized request argument|unknown (?:parameter|field|name)|extra (?:inputs|fields) (?:are )?not permitted|is not supported (?:with|for|by|on) this model|not supported when|parallel_tool_calls|stream_options|response_format|tool_choice/i,
  ],
  ["image_unsupported", /\bimage_url\b|\bimages?\b[^.]{0,40}(?:not supported|unsupported|cannot|invalid)|\bvision\b/i],
  [
    "model_not_found",
    /model[^.]{0,80}(?:not found|does not exist|no longer available|is not available)|(?:unknown|invalid|unsupported) model\b|no such model|model_not_found|not_found_error/i,
  ],
  ["request_too_large", /too large|payload too large|request entity/i],
  ["malformed_body", /invalid json|could not parse|failed to parse|malformed|json_parse|invalid payload/i],
];

/**
 * Request fields a provider's blamed path may start at. A path that
 * starts anywhere else is not sent: it could be a word of the user's
 * own text that happens to look like a path.
 */
const KNOWN_PARAM_ROOTS = new Set([
  "messages",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "parallel_tool_calls",
  "model",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop",
  "n",
  "seed",
  "stream",
  "stream_options",
  "response_format",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "metadata",
  "system",
  "input",
  "contents",
  "system_instruction",
  "generation_config",
  "generationConfig",
  "tool_config",
  "GenerateContentRequest",
]);

/**
 * The roots a path read out of the provider's PROSE may start at: the
 * containers of a request. A scalar root (`model`, `temperature`) is
 * taken only from a declared `param`; in prose, `model.Q4_K_M` is a file
 * name, not a field.
 */
const TEXT_PATH_ROOTS = new Set([
  "messages",
  "tools",
  "functions",
  "tool_choice",
  "response_format",
  "stream_options",
  "contents",
  "system_instruction",
  "generation_config",
  "generationConfig",
  "tool_config",
  "GenerateContentRequest",
]);

/** A field path: a root word, then `.word`, `.3` or `[3]` links. */
const PATH_RE =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]{0,31})((?:\.[A-Za-z_][A-Za-z0-9_]{0,31}|\.\d{1,6}|\[\d{1,6}\]){0,10})/g;

/** What a normalized path may look like on the wire. */
const SAFE_PARAM_RE = /^[A-Za-z_][A-Za-z0-9_.[\]*]{0,95}$/;

/** `error.code`: bounded enum shape, either case (`INVALID_ARGUMENT`). */
const SAFE_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/**
 * Links below the root that are the request's own structure, the same
 * words in every request whoever sends it. Any other link may be a name
 * the user or a tool chose (`tools.acme_payroll_sync`,
 * `messages.private_notes`), so the path is cut there to `*`.
 */
const STRUCTURAL_LINKS = new Set([
  "messages", "tools", "contents", "content", "text", "parts", "part",
  "role", "name", "type", "id", "index",
  "function", "functions", "function_call", "functionCall",
  "function_response", "functionResponse", "function_declarations",
  "functionDeclarations", "parameters", "input_schema", "json_schema",
  "schema", "strict", "description",
  "tool_calls", "tool_call_id", "tool_use", "tool_use_id", "tool_result",
  "tool_choice", "image_url", "url", "source", "media_type", "mime_type",
  "inline_data", "inlineData", "file_data", "fileData", "data",
  "cache_control", "reasoning_content", "thought_signature",
  "thoughtSignature", "extra_content", "google", "refusal", "signature",
  "system_instruction", "generation_config", "generationConfig",
  "tool_config", "response_format", "stream_options",
  "items", "required", "enum", "format", "anyOf", "oneOf", "allOf",
]);

/**
 * Links whose children are names chosen by a tool, a schema or the
 * user: a tool call's arguments, a tool result's keys, a schema's
 * property and definition maps. The link itself is kept, then `*`.
 */
const CUT_AFTER_LINKS = new Set([
  "args", "arguments", "input", "response",
  "properties", "patternProperties", "definitions", "$defs",
  "dependentSchemas", "dependentRequired", "dependencies",
]);

/** Extensions that make a dotted word a file name, not a field path. */
const FILE_EXTENSIONS = new Set([
  "txt", "md", "json", "jsonl", "yaml", "yml", "toml", "csv", "tsv",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png", "jpg",
  "jpeg", "gif", "webp", "svg", "html", "htm", "xml", "log", "js",
  "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "sh", "zip", "tar", "gz", "gguf",
  "bin", "safetensors", "sqlite", "db", "env", "ini", "cfg", "conf",
]);

const MAX_CAUSE_DEPTH = 5;

/**
 * The detail of the outermost error on the chain that carries a provider
 * body (the same duck-typed `.body` walk as
 * `extractSafeUpstreamErrorType`), or `{}` when none does.
 */
export function extractUpstreamErrorDetail(err: unknown): UpstreamErrorDetail {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return {};
    const body = (current as { body?: unknown }).body;
    if (body !== null && typeof body === "object") {
      return detailOfBody(body as Record<string, unknown>, current);
    }
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return {};
    current = next;
  }
  return {};
}

function detailOfBody(
  body: Record<string, unknown>,
  owner: object,
): UpstreamErrorDetail {
  const text = [body.message, body.upstreamMessage, body.text]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const out: UpstreamErrorDetail = {};
  const status = (owner as { status?: unknown }).status;
  const reason = classifyUpstreamReason(text, typeof status === "number" ? status : null);
  if (reason !== null) out.upstreamReason = reason;
  const param = extractUpstreamParam(text);
  if (param !== undefined) out.upstreamErrorParam = param;
  // `error.code` when it is a word; Google's is only the HTTP number,
  // and its `error.status` (`INVALID_ARGUMENT`) is the word.
  const code = [body.code, body.status].find(
    (value): value is string => typeof value === "string" && SAFE_CODE_RE.test(value),
  );
  if (code !== undefined) out.upstreamErrorCode = code;
  return out;
}

/**
 * The reason word for a provider's refusal text. Null only when there is
 * no text at all (a body that kept just `{ type }`, such as
 * `LlamaServerError`'s): `other` would then claim a wording that was
 * never read.
 */
export function classifyUpstreamReason(
  text: string,
  status: number | null = null,
): UpstreamReason | null {
  if (status === 402) return "out_of_credit";
  if (text.trim().length === 0) return null;
  for (const [reason, pattern] of REASON_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return "other";
}

/**
 * The request field the provider blamed: OpenAI's `"param"` first, then
 * the first known field path in the text.
 */
export function extractUpstreamParam(text: string): string | undefined {
  const declared = /"param"\s*:\s*"([^"\n]{1,160})"/.exec(text)?.[1];
  if (declared !== undefined) {
    const normalized = normalizeParamPath(declared);
    if (normalized !== undefined) return normalized;
  }
  for (const match of text.matchAll(PATH_RE)) {
    const root = match[1]!;
    const rest = match[2] ?? "";
    if (!TEXT_PATH_ROOTS.has(root)) continue;
    // A bare root word ("messages", "tools") is a word of prose as often
    // as a field name; only a declared `param` may be one word.
    if (rest.length === 0) continue;
    if (looksLikeFileName(text, match.index ?? 0, rest)) continue;
    const normalized = normalizeParamPath(`${root}${rest}`);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/**
 * A dotted word that is part of a file path or names a file:
 * `/Users/n/Documents/contents.txt`, `C:\\notes\\messages.md`,
 * `~/tools.json`, `./contents.v2`.
 */
function looksLikeFileName(text: string, at: number, rest: string): boolean {
  const before = at > 0 ? text[at - 1]! : "";
  if (before === "/" || before === "\\" || before === "~" || before === ".") {
    return true;
  }
  const links = rest.split(/[.[\]]/).filter((link) => link.length > 0);
  const last = links[links.length - 1]?.toLowerCase();
  return last !== undefined && FILE_EXTENSIONS.has(last);
}

/**
 * `messages[3].content.0.text` → `messages[].content[].text`. The root
 * must be a known request field; below it only structural links are
 * kept (`STRUCTURAL_LINKS`), a link that opens a map of chosen names
 * (`CUT_AFTER_LINKS`) is kept and followed by `*`, and any other link,
 * a named bracket (`properties[foo]`) included, becomes `*` and ends
 * the path.
 */
export function normalizeParamPath(raw: string): string | undefined {
  const links = raw
    .trim()
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[[^\]]*\]/g, ".*")
    .split(".")
    .filter((link) => link.length > 0);
  const root = links[0];
  if (root === undefined || !KNOWN_PARAM_ROOTS.has(root)) return undefined;
  let path = root;
  for (const link of links.slice(1, 10)) {
    if (/^\d+$/.test(link)) {
      path += "[]";
      continue;
    }
    if (CUT_AFTER_LINKS.has(link)) {
      path += `.${link}.*`;
      break;
    }
    if (!STRUCTURAL_LINKS.has(link)) {
      path += ".*";
      break;
    }
    path += `.${link}`;
  }
  return SAFE_PARAM_RE.test(path) ? path : undefined;
}
