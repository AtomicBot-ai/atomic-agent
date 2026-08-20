/**
 * HTTP header values are byte strings: every character must fit in a
 * single byte (0-255). `fetch` enforces this and throws a raw
 * `ByteString` conversion error the moment a header value carries a
 * character above that range. An API key with a stray non-ASCII
 * character (a Cyrillic letter pasted by mistake, a smart quote from a
 * doc) is the usual cause, and the raw error names an index and a code
 * point rather than the key, so the guards here catch it first and say
 * what to do instead.
 */

/** True when every character of `s` is in the ASCII range (code points 0-127). */
export function isAsciiOnly(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s);
}

/**
 * Return `apiKey` unchanged when it can be sent in an `Authorization`
 * header, or throw a clear error naming the fix. Header values must be
 * ASCII, so a non-ASCII key would otherwise blow up inside `fetch` with
 * an opaque `ByteString` message that never mentions the key at all.
 */
export function assertAsciiApiKey(apiKey: string): string {
  if (!isAsciiOnly(apiKey)) {
    throw new Error(
      "API key contains non-ASCII characters. Use a plain ASCII key.",
    );
  }
  return apiKey;
}
