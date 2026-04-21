import type { Extractor } from "./extractor-types.js";

/**
 * Minimal pure-JS RTF text extractor.
 *
 * RTF is a plain-text format where content is interleaved with control
 * words (`\word`), control symbols (`\\`, `\{`, `\-`…), and groups
 * (`{...}`). For token-frugal text extraction we need only these rules:
 *
 *  1. `\{`, `\}`, `\\`     → literal `{`, `}`, `\`.
 *  2. `\'hh`               → single byte `hh` (hex) decoded per codepage.
 *  3. `\par`, `\line`, `\sect` → newline.
 *  4. `\tab`               → tab.
 *  5. `\u-?N(\s|\?)?`      → Unicode char by code point (negative = signed).
 *  6. `\*\xxx{...}`        → ignorable destination, discard the whole group.
 *  7. Known header destinations (`\fonttbl`, `\colortbl`, `\stylesheet`,
 *     `\info`, `\*\generator`, `\pict`, `\objdata`, etc.) → discard.
 *  8. Anything else `\word[-]?N?` → unknown control; skip its text effect.
 *
 * We do NOT implement bidi, table structure, revision marks, fields, etc.
 * If the file uses non-standard-ASCII beyond `\'hh` ranges, codepoints may
 * decode as latin1 and appear mojibake. That's acceptable for a read-only
 * best-effort tool: the common case (text documents produced by Word or
 * LibreOffice on latin1/cp1252) comes through cleanly.
 */
export const rtfExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const source = input.data.toString("latin1");
  const text = parseRtf(source, warnings);
  return {
    format: "rtf",
    text: text.replace(/[\t ]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(),
    warnings,
  };
};

const IGNORABLE_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "objdata",
  "header",
  "footer",
  "footnote",
  "generator",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "revtbl",
]);

function parseRtf(src: string, warnings: string[]): string {
  let i = 0;
  const out: string[] = [];
  const groupStack: { ignore: boolean }[] = [];
  let ignoreDepth = 0;

  const emit = (s: string) => {
    if (ignoreDepth === 0) out.push(s);
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      // Detect ignorable groups: `{\*\xxx ...}` → discard content.
      let look = i + 1;
      while (look < src.length && (src[look] === " " || src[look] === "\n")) {
        look++;
      }
      let isIgnorable = false;
      if (src[look] === "\\" && src[look + 1] === "*") {
        isIgnorable = true;
      } else if (src[look] === "\\") {
        const match = /^\\([a-zA-Z]+)/.exec(src.slice(look));
        const destination = match?.[1];
        if (destination && IGNORABLE_DESTINATIONS.has(destination)) {
          isIgnorable = true;
        }
      }
      groupStack.push({ ignore: isIgnorable });
      if (isIgnorable) ignoreDepth++;
      i++;
      continue;
    }
    if (ch === "}") {
      const popped = groupStack.pop();
      if (popped?.ignore) ignoreDepth--;
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = src[i + 1];
      // Control symbol: `\\` `\{` `\}` `\'hh` `\~` `\-` etc.
      if (next === "\\" || next === "{" || next === "}") {
        emit(next);
        i += 2;
        continue;
      }
      if (next === "~") {
        emit("\u00A0"); // non-breaking space
        i += 2;
        continue;
      }
      if (next === "-" || next === "_") {
        // Optional/non-breaking hyphen; render as regular hyphen.
        emit("-");
        i += 2;
        continue;
      }
      if (next === "'") {
        const hex = src.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          const byte = parseInt(hex, 16);
          emit(decodeCp1252Byte(byte));
          i += 4;
          continue;
        }
        warnings.push(`malformed \\' escape near offset ${i}`);
        i += 2;
        continue;
      }
      if (next === "\n" || next === "\r") {
        emit("\n");
        i += 2;
        continue;
      }
      const cwMatch = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(src.slice(i));
      if (cwMatch && cwMatch[1]) {
        const word = cwMatch[1];
        const param = cwMatch[2];
        i += cwMatch[0].length;
        if (word === "u" && param) {
          // `\uNNNN` emits one Unicode char; the next `\uc`-many source
          // characters are an ANSI fallback that readers without Unicode
          // support would use. We have Unicode, so skip them.
          // Default skip count is 1; we don't track `\uc` state changes.
          const code = parseInt(param, 10);
          const cp = code < 0 ? code + 0x10000 : code;
          emit(String.fromCodePoint(cp));
          i += skipUnicodeFallback(src, i, 1);
          continue;
        }
        handleControlWord(word, param, emit);
        continue;
      }
      // Unknown lone backslash — skip.
      i += 2;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // Literal line breaks in the RTF source are formatting only; ignore.
      i++;
      continue;
    }
    if (ch !== undefined) emit(ch);
    i++;
  }
  return out.join("");
}

function handleControlWord(
  word: string,
  _param: string | undefined,
  emit: (s: string) => void,
): void {
  switch (word) {
    case "par":
    case "line":
    case "sect":
    case "page":
      emit("\n");
      return;
    case "tab":
      emit("\t");
      return;
    case "emdash":
      emit("\u2014");
      return;
    case "endash":
      emit("\u2013");
      return;
    case "lquote":
      emit("\u2018");
      return;
    case "rquote":
      emit("\u2019");
      return;
    case "ldblquote":
      emit("\u201C");
      return;
    case "rdblquote":
      emit("\u201D");
      return;
    case "bullet":
      emit("\u2022");
      return;
    default:
      // All other control words are formatting only; no text effect.
      return;
  }
}

const CP1252_OVERRIDES: Record<number, string> = {
  0x80: "\u20AC", 0x82: "\u201A", 0x83: "\u0192", 0x84: "\u201E",
  0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02C6",
  0x89: "\u2030", 0x8A: "\u0160", 0x8B: "\u2039", 0x8C: "\u0152",
  0x8E: "\u017D", 0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201C",
  0x94: "\u201D", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02DC", 0x99: "\u2122", 0x9A: "\u0161", 0x9B: "\u203A",
  0x9C: "\u0153", 0x9E: "\u017E", 0x9F: "\u0178",
};

/**
 * After emitting a `\uNNNN` Unicode char, consume the `\uc`-many fallback
 * characters that follow. A fallback may be either:
 *   - a plain character (including `?`), or
 *   - a control sequence (e.g. `\'hh`), which we treat as one unit.
 * Returns the number of source bytes consumed.
 */
function skipUnicodeFallback(src: string, from: number, count: number): number {
  let consumed = 0;
  let remaining = count;
  while (remaining > 0 && from + consumed < src.length) {
    const ch = src[from + consumed];
    if (ch === "\\") {
      // `\'hh` is 4 bytes; a full control word would eat text we want to
      // keep. Only the `\'` form is a single-char fallback.
      if (src[from + consumed + 1] === "'" &&
          /^[0-9a-fA-F]{2}$/.test(src.slice(from + consumed + 2, from + consumed + 4))) {
        consumed += 4;
        remaining--;
        continue;
      }
      // Not a recognised fallback escape; stop — the next iteration of
      // the main loop will handle it correctly.
      break;
    }
    if (ch === "{" || ch === "}" || ch === "\r" || ch === "\n") break;
    consumed++;
    remaining--;
  }
  return consumed;
}

/**
 * Decode a single `\'hh` byte per CP1252. For bytes 0x00-0x7F and 0xA0-0xFF
 * this is identical to latin1; bytes 0x80-0x9F are CP1252-specific glyphs
 * (smart quotes, dashes, trademark, etc.) that differ from pure latin1.
 */
function decodeCp1252Byte(byte: number): string {
  const override = CP1252_OVERRIDES[byte];
  if (override) return override;
  return String.fromCharCode(byte);
}
