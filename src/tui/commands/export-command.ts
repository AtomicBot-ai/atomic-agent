import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

import {
  chatExportFilename,
  encodeWinAnsi,
  exportChat,
  parseChatExportFormat,
  type ChatExportFormat,
  type SessionState,
} from "../../session/index.js";
import { describeToolCall } from "../../tools/describe-tool-call.js";

/**
 * `/export [md|docx|pdf|html] [path]` (ATO-1054): save the open chat as a
 * file with the same exporter as `atomic-agent export`.
 *
 * Modelled on Claude Code's `/export <filename>`, which writes the
 * conversation to that file in the current folder and says where: bare
 * `/export` here writes Markdown named after the chat into the folder
 * the terminal was started in, never over an existing file; a path is
 * written as given (overwriting, as Claude Code and `--out` do). Claude
 * Code's bare `/export` opens a copy-or-save dialog; there is no
 * clipboard step here, the saved path is the answer.
 */

export interface ChatExportRequest {
  readonly format: ChatExportFormat;
  /** As typed, or null for a file named after the chat in the current folder. */
  readonly path: string | null;
}

const FORMAT_WORDS = new Set(["md", "markdown", "docx", "word", "pdf", "html", "htm"]);

const EXTENSION_FORMAT: Record<string, ChatExportFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".docx": "docx",
  ".pdf": "pdf",
  ".html": "html",
  ".htm": "html",
};

function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/**
 * The arguments after `/export`: a leading format word, then the path
 * (spaces allowed, quotes optional). Without a format word the whole
 * argument is the path and its extension picks the format (Markdown when
 * it names none), so `/export notes` writes `notes.md`.
 */
export function parseExportCommand(rawArgs: string): ChatExportRequest {
  const args = rawArgs.trim();
  if (args.length === 0) return { format: "markdown", path: null };
  const first = args.split(/\s+/, 1)[0] ?? "";
  if (FORMAT_WORDS.has(first.toLowerCase())) {
    const format = parseChatExportFormat(first) ?? "markdown";
    const path = unquote(args.slice(first.length));
    return { format, path: path.length > 0 ? path : null };
  }
  const path = unquote(args);
  return { format: EXTENSION_FORMAT[extname(path).toLowerCase()] ?? "markdown", path };
}

const EXTENSION: Record<ChatExportFormat, string> = { markdown: ".md", html: ".html", docx: ".docx", pdf: ".pdf" };

/**
 * Where the file goes: `~` expanded, relative paths against `cwd`, a
 * folder (or a path ending in `/`) gets the chat's file name, a name
 * without an extension gets the format's. No path: the chat's file name
 * in `cwd`, numbered `name (2).md` rather than writing over a file.
 */
export function resolveExportPath(
  state: SessionState,
  request: ChatExportRequest,
  cwd: string,
  home: string = homedir(),
): string {
  const fallback = chatExportFilename(state, request.format);
  if (request.path === null) return firstFreePath(join(cwd, fallback));
  const typed = request.path.replace(/^~(?=$|[\\/])/, home);
  const full = isAbsolute(typed) ? typed : resolve(cwd, typed);
  if (/[\\/]$/.test(typed) || isDirectory(full)) return join(full, fallback);
  return extname(full) === "" ? `${full}${EXTENSION[request.format]}` : full;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstFreePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return path;
}

const FORMAT_LABEL: Record<ChatExportFormat, string> = { markdown: "Markdown", html: "HTML", docx: "Word", pdf: "PDF" };

/**
 * Write `state` as `request` asks and return the line for the chat:
 * where it went, or why it did not.
 */
export async function writeChatExport(
  state: SessionState | null,
  request: ChatExportRequest,
  cwd: string = process.cwd(),
): Promise<string> {
  if (!state || !state.turns.some((t) => t.kind === "user")) return "nothing to export yet: this chat has no messages";
  let path = "";
  try {
    path = resolveExportPath(state, request, cwd);
    const file = await exportChat(state, request.format, {
      describeToolCall: (call) => describeToolCall({ name: call.tool, args: call.args, ok: call.ok }).line,
    });
    writeFileSync(path, file.body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `export failed${path ? ` (${path})` : ""}: ${reason}`;
  }
  const note =
    request.format === "pdf" && encodeWinAnsi(state.turns.map((t) => ("text" in t ? t.text : "")).join("\n")).changed > 0
      ? ". The PDF uses the standard fonts, so text outside Western European scripts is transliterated or shown as ?; Markdown and Word keep it"
      : "";
  return `chat exported as ${FORMAT_LABEL[request.format]}: ${path}${note}`;
}
