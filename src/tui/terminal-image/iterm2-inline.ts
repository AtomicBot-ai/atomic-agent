/**
 * iTerm2 inline-file encoder (OSC 1337, ATO-660), also understood by
 * WezTerm. Pure. https://iterm2.com/documentation-images.html
 *
 * Not wired into the chat yet: an OSC 1337 picture is drawn at the
 * cursor into the cells below it, and Ink's full-frame repaint rewrites
 * those cells several times a second, so the picture would be erased or
 * re-sent on every frame. There is no placeholder mechanism like kitty's
 * to host it inside the frame. The encoder is here, tested, for the day
 * the TUI has somewhere static to write it.
 */
export interface Iterm2InlineOptions {
  /** Width / height in cells; the terminal keeps the aspect ratio. */
  readonly cols: number;
  readonly rows: number;
  /** Shown by iTerm2 in its download prompt; optional. */
  readonly name?: string;
}

export function encodeIterm2Inline(bytes: Uint8Array, options: Iterm2InlineOptions): string {
  const args = [
    ...(options.name ? [`name=${Buffer.from(options.name, "utf8").toString("base64")}`] : []),
    `size=${bytes.length}`,
    `width=${options.cols}`,
    `height=${options.rows}`,
    "preserveAspectRatio=1",
    "inline=1",
  ];
  return `\u001b]1337;File=${args.join(";")}:${Buffer.from(bytes).toString("base64")}\u0007`;
}
