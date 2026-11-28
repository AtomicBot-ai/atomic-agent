/**
 * The block a message carries for the files it `@`-mentioned, and the
 * inverse the chat uses to show the message as it was typed.
 *
 * The block goes AFTER the typed text, the way the `[attachments]` block
 * of the channels does (src/channels/attachments/inbox.ts), so the model
 * reads the request first and the files under it. Its opening line and
 * its summary list are written here and nowhere else, which is what lets
 * {@link splitMentionedFiles} find them again without parsing file
 * contents: the transcript keeps the full message (it is what the model
 * saw), and the bubble shows the typed text plus one line per file.
 */

export const MENTION_BLOCK_OPEN = "<mentioned-files>";
export const MENTION_BLOCK_CLOSE = "</mentioned-files>";
const INTRO =
  "Files the user referenced with @, read from the working directory:";
const SEPARATOR = `\n\n${MENTION_BLOCK_OPEN}\n${INTRO}\n`;

export interface MentionedFile {
  /** The path as the user wrote it, relative to the working directory. */
  path: string;
  /** Size of the whole file on disk. */
  bytes: number;
  /** The text inlined into the message (possibly cut). */
  content: string;
  /** Set when `content` is only the head of the file. */
  truncatedTo?: number;
  /** Set when the file was not inlined at all (binary, over budget). */
  skipped?: string;
}

/** Same rounding as the attachments block, so both read alike. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One summary line: `src/app.ts (3 KB)`, with any cut said plainly. */
export function describeMentionedFile(file: MentionedFile): string {
  const size = formatBytes(file.bytes);
  if (file.skipped !== undefined) return `${file.path} (${size}, not inlined: ${file.skipped})`;
  if (file.truncatedTo !== undefined) {
    return `${file.path} (${size}, truncated to the first ${formatBytes(file.truncatedTo)})`;
  }
  return `${file.path} (${size})`;
}

function fileSection(file: MentionedFile): string {
  if (file.skipped !== undefined) return "";
  const note =
    file.truncatedTo !== undefined
      ? `\n[truncated: showing the first ${formatBytes(file.truncatedTo)} of ${formatBytes(file.bytes)}; read the file itself for the rest]`
      : "";
  const body = file.content.endsWith("\n") ? file.content : `${file.content}\n`;
  return `\n<file path=${JSON.stringify(file.path)}>\n${body}</file>${note}\n`;
}

/** `text` followed by the block for `files`; `text` alone when empty. */
export function appendMentionBlock(
  text: string,
  files: readonly MentionedFile[],
): string {
  if (files.length === 0) return text;
  const summary = files.map((f) => `- ${describeMentionedFile(f)}`).join("\n");
  const sections = files.map(fileSection).join("");
  return `${text}${SEPARATOR}${summary}\n${sections}${MENTION_BLOCK_CLOSE}`;
}

export interface SplitMessage {
  /** The text as the user typed it. */
  typed: string;
  /** The summary lines of the block (`src/app.ts (3 KB)`). */
  files: string[];
}

/** Undo {@link appendMentionBlock}; `null` when there is no block. */
export function splitMentionedFiles(message: string): SplitMessage | null {
  const at = message.indexOf(SEPARATOR);
  if (at < 0 || !message.endsWith(MENTION_BLOCK_CLOSE)) return null;
  const files: string[] = [];
  for (const line of message.slice(at + SEPARATOR.length).split("\n")) {
    if (!line.startsWith("- ")) break;
    files.push(line.slice(2));
  }
  return { typed: message.slice(0, at), files };
}

/** What the chat bubble shows: the typed text and a line per file. */
export function collapseMentionedFiles(message: string): string {
  const split = splitMentionedFiles(message);
  if (!split) return message;
  const lines = split.files.map((f) => `  + ${f}`);
  return [split.typed, ...lines].join("\n");
}

/** What input history recalls: just the typed text. */
export function typedTextOf(message: string): string {
  return splitMentionedFiles(message)?.typed ?? message;
}
