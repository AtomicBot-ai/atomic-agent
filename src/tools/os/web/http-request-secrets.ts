import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import { looksLikeSecretPlaceholder } from "../../../sandbox/secret-placeholders.js";
import { checkToolSecretNames, fillToolSecretTexts } from "../../tool-secret-use.js";

/**
 * `{{secret:NAME}}` in `os.http.request` (ATO-2530): header values only,
 * as in `Authorization: Bearer {{secret:GITHUB_TOKEN}}`. Precedent:
 * 1Password `op run` and OpenClaw secrets, where the request names the
 * secret and the runtime fills it in.
 *
 * Not in the URL or the body: a URL is shown, logged and sent on in
 * `Referer`, and a body is often echoed back whole. A placeholder there
 * fails the call instead of going out as written. The headers that got
 * a value are sent to the approved origin only: a redirect elsewhere
 * drops them, whatever their name.
 */

export type HttpSecretCheck =
  | { ok: true; names: string[]; headerNames: string[] }
  | { ok: false; message: string };

export interface HttpSecretArgs {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function checkHttpSecrets(
  args: HttpSecretArgs,
  source: ToolSecretSource | undefined,
): HttpSecretCheck {
  const misplaced =
    looksLikeSecretPlaceholder(args.url) ? "the URL"
    : args.body !== undefined && looksLikeSecretPlaceholder(args.body) ? "the body"
    : Object.keys(args.headers).some(looksLikeSecretPlaceholder) ? "a header name"
    : null;
  if (misplaced !== null) {
    return {
      ok: false,
      message: `a secret placeholder works only in a header value, not in ${misplaced} (headers: {"Authorization": "Bearer {{secret:NAME}}"})`,
    };
  }
  const check = checkToolSecretNames(Object.values(args.headers), source);
  if (!check.ok) return check;
  const headerNames = Object.keys(args.headers).filter((key) =>
    looksLikeSecretPlaceholder(args.headers[key]!),
  );
  return { ok: true, names: check.names, headerNames };
}

export type HttpSecretFill =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; message: string };

/**
 * `headers` with the placeholders replaced by their values, fetched now
 * (after the approval). A value that would break the header line (CR,
 * LF) is refused; the message names the header, never the value.
 */
export async function fillHttpSecretHeaders(
  headers: Record<string, string>,
  names: readonly string[],
  source: ToolSecretSource,
): Promise<HttpSecretFill> {
  const keys = Object.keys(headers);
  const filled = await fillToolSecretTexts(
    keys.map((key) => headers[key]!),
    names,
    source,
    { shell: false },
  );
  if (!filled.ok) return filled;
  const out: Record<string, string> = {};
  for (const [index, key] of keys.entries()) {
    const value = filled.texts[index]!;
    if (/[\r\n]/.test(value)) {
      return { ok: false, message: `the secret filled into header ${key} holds a line break, so the request is not sent` };
    }
    out[key] = value;
  }
  return { ok: true, headers: out };
}
