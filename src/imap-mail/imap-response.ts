/**
 * Reads IMAP server responses (RFC 3501 section 7) off a byte stream.
 *
 * A response is one line, except that a line ending in `{n}` is followed
 * by exactly `n` raw bytes (a literal) and then the rest of the line.
 * The reader keeps the line text with the `{n}` markers in place and
 * hands the literal bytes back separately, in order, so a caller can
 * pick out `BODY[]` without the bytes ever being read as text.
 *
 * Bytes arrive in arbitrary chunks; {@link ImapResponseReader.push}
 * returns every response completed so far and keeps the rest.
 */

export interface ImapResponse {
  /** `*` (untagged), `+` (continuation) or the command tag. */
  tag: string;
  /** Everything after the tag, literals shown as their `{n}` marker. */
  text: string;
  literals: Buffer[];
}

/** A line longer than this without CRLF means the peer is not speaking IMAP. */
export const MAX_LINE_BYTES = 1024 * 1024;

export class ImapProtocolError extends Error {
  override readonly name = "ImapProtocolError";
}

export class ImapResponseReader {
  private buffer: Buffer = Buffer.alloc(0);
  private parts: string[] = [];
  private literals: Buffer[] = [];
  private need = 0;

  constructor(private readonly maxLiteralBytes: number) {}

  push(chunk: Buffer): ImapResponse[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: ImapResponse[] = [];
    for (;;) {
      if (this.need > 0) {
        if (this.buffer.length < this.need) break;
        this.literals.push(Buffer.from(this.buffer.subarray(0, this.need)));
        this.buffer = this.buffer.subarray(this.need);
        this.need = 0;
        continue;
      }
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) {
        if (this.buffer.length > MAX_LINE_BYTES) {
          throw new ImapProtocolError("server line too long");
        }
        break;
      }
      const line = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 2);
      this.parts.push(line);
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (literal) {
        const size = Number(literal[1]);
        if (size > this.maxLiteralBytes) {
          throw new ImapProtocolError(`server literal of ${size} bytes is over the limit`);
        }
        this.need = size;
        // A zero-length literal is complete at once.
        if (size === 0) this.literals.push(Buffer.alloc(0));
        continue;
      }
      out.push(this.finish());
    }
    return out;
  }

  private finish(): ImapResponse {
    const full = this.parts.join("");
    const literals = this.literals;
    this.parts = [];
    this.literals = [];
    const space = full.indexOf(" ");
    return space < 0
      ? { tag: full, text: "", literals }
      : { tag: full.slice(0, space), text: full.slice(space + 1), literals };
  }
}

/** `[CODE args]` at the start of a status text, e.g. `UIDVALIDITY 3857529045`. */
export function responseCode(text: string): { code: string; args: string } | null {
  const m = /^(?:OK|NO|BAD|PREAUTH|BYE)?\s*\[([A-Z0-9.-]+)(?:\s+([^\]]*))?\]/i.exec(text);
  return m ? { code: m[1]!.toUpperCase(), args: m[2] ?? "" } : null;
}

/** An IMAP quoted string; refuses CR, LF and NUL, which no quoted string may hold. */
export function quoteImapString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000]/.test(value)) throw new Error("IMAP string may not contain line breaks");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
