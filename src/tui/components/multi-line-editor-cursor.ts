export interface Cursor {
  readonly row: number;
  readonly col: number;
  readonly offset: number;
}

/**
 * Convert a flat offset into the buffer string into an Ink-friendly
 * `{row, col, offset}` triple. Row indices start at zero; columns count
 * grapheme-sized bytes (good enough for ASCII-dominant chat input —
 * multi-byte graphemes degrade to "wider than one column" naturally).
 */
export function cursorToRowCol(value: string, cursor: number): Cursor {
  const clamped = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, clamped);
  const newlineIdx = before.lastIndexOf("\n");
  const row = before.split("\n").length - 1;
  const col = newlineIdx === -1 ? clamped : clamped - newlineIdx - 1;
  return { row, col, offset: clamped };
}

/** Convert a `{row, col}` location back into a flat offset. */
export function rowColToCursor(
  lines: readonly string[],
  row: number,
  col: number,
): number {
  let offset = 0;
  for (let i = 0; i < row; i += 1) offset += (lines[i] ?? "").length + 1;
  return offset + col;
}

export function lineStart(value: string, cursor: number): number {
  const before = value.slice(0, cursor);
  const idx = before.lastIndexOf("\n");
  return idx === -1 ? 0 : idx + 1;
}

export function lineEnd(value: string, cursor: number): number {
  const idx = value.indexOf("\n", cursor);
  return idx === -1 ? value.length : idx;
}

/** Offset of the start of the word under (or immediately before) the cursor. */
export function findWordStart(value: string, cursor: number): number {
  let i = cursor - 1;
  while (i > 0 && /\s/.test(value[i] ?? "")) i -= 1;
  while (i > 0 && /\S/.test(value[i - 1] ?? "")) i -= 1;
  return Math.max(0, i);
}

export function isOnFirstLine(value: string, cursor: number): boolean {
  return value.slice(0, cursor).indexOf("\n") === -1;
}

export function isOnLastLine(value: string, cursor: number): boolean {
  return value.slice(cursor).indexOf("\n") === -1;
}
