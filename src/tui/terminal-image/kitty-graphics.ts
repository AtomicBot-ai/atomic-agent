/**
 * Kitty graphics protocol encoders (ATO-660). Pure: bytes in, escape
 * strings out. https://sw.kovidgoyal.net/kitty/graphics-protocol/
 *
 * The TUI uses **Unicode placeholders** (`U=1`) rather than placing an
 * image at the cursor. Ink repaints the whole frame several times a
 * second and moves blocks around as the chat scrolls; an image pinned to
 * a screen position would be left behind or painted over. A placeholder
 * is ordinary text instead: one cell per image cell, the character
 * U+10EEEE plus two combining marks that say which row and column of the
 * picture the cell shows, coloured with the image id as its foreground.
 * Ink measures each such cell as one column (a private-use letter with
 * zero-width marks), lays it out, clips it and repaints it like any
 * other text, and the terminal draws the matching slice of the picture
 * there. The picture itself is sent once, out of band.
 */

const APC = "\u001b_G";
const ST = "\u001b\\";
/** Payload bytes per chunk the protocol allows (a multiple of 4). */
export const KITTY_CHUNK_SIZE = 4096;
const PLACEHOLDER = String.fromCodePoint(0x10eeee);

/**
 * Row / column diacritics, in the protocol's order: index n stands for
 * row (or column) n. The first 64 entries of the spec's
 * `rowcolumn-diacritics.txt` table; the box is capped well under that.
 */
const DIACRITICS: readonly number[] = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f,
  0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357,
  0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
  0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
  0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
];

/** Largest row / column count a placeholder grid can address here. */
export const KITTY_MAX_PLACEHOLDER_CELLS = DIACRITICS.length;

/** Image ids ride in a 24-bit foreground colour, so 1..0xFFFFFF. */
export function isValidKittyImageId(id: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= 0xffffff;
}

function assertBox(id: number, cols: number, rows: number): void {
  if (!isValidKittyImageId(id)) throw new Error(`kitty image id out of range: ${id}`);
  for (const n of [cols, rows]) {
    if (!Number.isInteger(n) || n < 1 || n > KITTY_MAX_PLACEHOLDER_CELLS) {
      throw new Error(`kitty placeholder size out of range: ${cols}x${rows}`);
    }
  }
}

/** Split base64 into protocol chunks. Exported for tests. */
export function chunkBase64(payload: string, size = KITTY_CHUNK_SIZE): string[] {
  if (payload.length === 0) return [""];
  const chunks: string[] = [];
  for (let at = 0; at < payload.length; at += size) chunks.push(payload.slice(at, at + size));
  return chunks;
}

/**
 * Transmit a PNG and create a virtual placement of `cols` x `rows`
 * cells for placeholders to show (`a=T,U=1`). `q=2` keeps the terminal
 * from answering on stdin, which the TUI is reading as keystrokes. The
 * first chunk carries every key; the rest carry only `m` (and `q`), as
 * the protocol requires.
 */
export function encodeKittyTransmit(png: Uint8Array, id: number, cols: number, rows: number): string {
  assertBox(id, cols, rows);
  const chunks = chunkBase64(Buffer.from(png).toString("base64"));
  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;
      const keys =
        index === 0
          ? `a=T,U=1,f=100,t=d,i=${id},c=${cols},r=${rows},q=2,m=${more}`
          : `m=${more},q=2`;
      return `${APC}${keys};${chunk}${ST}`;
    })
    .join("");
}

/** Free the image and every placement of it in the terminal. */
export function encodeKittyDelete(id: number): string {
  if (!isValidKittyImageId(id)) throw new Error(`kitty image id out of range: ${id}`);
  return `${APC}a=d,d=I,i=${id},q=2${ST}`;
}

/** The SGR that sets the foreground to the colour encoding `id`. */
export function kittyIdColor(id: number): string {
  const r = (id >> 16) & 0xff;
  const g = (id >> 8) & 0xff;
  const b = id & 0xff;
  return `\u001b[38;2;${r};${g};${b}m`;
}

/**
 * One text line per image row: `cols` placeholder cells, each with its
 * row and column marks, wrapped in the id colour and reset after.
 */
export function kittyPlaceholderRows(id: number, cols: number, rows: number): string[] {
  assertBox(id, cols, rows);
  const color = kittyIdColor(id);
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const rowMark = String.fromCodePoint(DIACRITICS[row]!);
    let line = color;
    for (let col = 0; col < cols; col++) {
      line += PLACEHOLDER + rowMark + String.fromCodePoint(DIACRITICS[col]!);
    }
    lines.push(`${line}\u001b[39m`);
  }
  return lines;
}
