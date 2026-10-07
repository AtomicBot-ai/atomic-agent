/**
 * True when every code point of the reported input is printable text.
 * Rejects C0 controls (below 0x20) and DEL (0x7f) so escape-sequence
 * fragments and raw control bytes can never land in a filter. Shared
 * with the Cloud pane's inline model filter so both text surfaces apply
 * the same discipline.
 */
export function isPrintableFilterInput(input: string): boolean {
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}
