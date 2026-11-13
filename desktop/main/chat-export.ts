/* ATO-1054 — the chat row's "Export…": save one chat as Markdown, PDF,
   Word or HTML.

   The agent renders the document (GET /api/sessions/{id}/export, see
   src/session/chat-export.ts), so the desktop and `atag export` write the
   same file. The person picks a place and a type in the system save
   dialog; the type comes from the extension they end up with. PDF is the
   agent's HTML, written to a temp file, printed by Electron's printToPDF
   in a hidden window that runs no script and is denied every request but
   that file — the HTML carries
   a CSP that loads nothing, and the window refuses requests on top of it.

   An agent from before the route answers 404: the window says to update. */

import type { BrowserWindow, Dialog, IpcMain, SaveDialogOptions } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type ChatExportKind = "markdown" | "pdf" | "docx" | "html";

/** What the agent route answers. */
export interface ChatExportWire {
  id: string;
  format: "markdown" | "html" | "docx";
  filename: string;
  mimeType: string;
  encoding: "utf8" | "base64";
  content: string;
}

const EXT: Record<ChatExportKind, string> = { markdown: "md", pdf: "pdf", docx: "docx", html: "html" };

/** The save dialog's types, Markdown first: it is the default. */
export const CHAT_EXPORT_FILTERS: NonNullable<SaveDialogOptions["filters"]> = [
  { name: "Markdown", extensions: ["md"] },
  { name: "PDF", extensions: ["pdf"] },
  { name: "Word document", extensions: ["docx"] },
  { name: "Web page", extensions: ["html"] },
];

/** The type a chosen path asks for; no or an unknown extension is Markdown (and gets `.md`). */
export function chatExportTarget(filePath: string): { kind: ChatExportKind; path: string } {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath);
  const ext = m ? (m[1] ?? "").toLowerCase() : "";
  if (ext === "pdf") return { kind: "pdf", path: filePath };
  if (ext === "docx") return { kind: "docx", path: filePath };
  if (ext === "html" || ext === "htm") return { kind: "html", path: filePath };
  if (ext === "md" || ext === "markdown") return { kind: "markdown", path: filePath };
  return { kind: "markdown", path: `${filePath}.md` };
}

/** `Trip plan.md` from the agent becomes `Trip plan.pdf` etc. */
export function chatExportDefaultName(agentFilename: string, kind: ChatExportKind): string {
  const base = agentFilename.replace(/\.[A-Za-z0-9]+$/, "") || "chat";
  return `${base}.${EXT[kind]}`;
}

/** The text the window shows for a failure. */
export function chatExportErrorText(error: unknown): string {
  const msg = String(error instanceof Error ? error.message : error ?? "");
  if (/HTTP 404/.test(msg) && /\/export/.test(msg)) return "This agent version cannot export chats. Update Atomic Agent.";
  return msg.replace(/^Error:\s*/, "");
}

export interface ChatExportDeps {
  ipcMain: Pick<IpcMain, "handle">;
  dialog: Pick<Dialog, "showSaveDialog">;
  window: () => BrowserWindow | null;
  /** The agent route, through the app's client. */
  fetchExport: (id: string, format: ChatExportWire["format"]) => Promise<ChatExportWire>;
  /** HTML to PDF bytes. */
  printPdf: (html: string) => Promise<Buffer>;
  writeFile?: (path: string, data: string | Buffer) => Promise<void>;
}

export type ChatExportResult =
  | { ok: true; path: string; kind: ChatExportKind }
  | { ok: false; reason: "canceled" | "bad-id" }
  | { ok: false; reason: "failed"; error: string };

/** Ask where, fetch the document, write it. */
export async function exportChatToFile(deps: ChatExportDeps, id: unknown): Promise<ChatExportResult> {
  if (typeof id !== "string" || !id || id.length > 256) return { ok: false, reason: "bad-id" };
  try {
    // The Markdown first: it names the file, and it is what most people save.
    const md = await deps.fetchExport(id, "markdown");
    const owner = deps.window();
    const opts: SaveDialogOptions = {
      title: "Export chat",
      defaultPath: chatExportDefaultName(md.filename, "markdown"),
      filters: CHAT_EXPORT_FILTERS,
    };
    const picked = owner ? await deps.dialog.showSaveDialog(owner, opts) : await deps.dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return { ok: false, reason: "canceled" };
    const target = chatExportTarget(picked.filePath);
    let data: string | Buffer;
    if (target.kind === "markdown") data = md.content;
    else if (target.kind === "docx") data = Buffer.from((await deps.fetchExport(id, "docx")).content, "base64");
    else {
      const html = (await deps.fetchExport(id, "html")).content;
      data = target.kind === "html" ? html : await deps.printPdf(html);
    }
    await (deps.writeFile ?? writeFile)(target.path, data);
    return { ok: true, path: target.path, kind: target.kind };
  } catch (e) {
    return { ok: false, reason: "failed", error: chatExportErrorText(e) };
  }
}

/**
 * HTML to PDF in a hidden window with no script and no network.
 *
 * The HTML goes through a temp file and `loadFile`, not a `data:` URL:
 * Chromium caps URLs at 2 MiB, and a long chat's HTML passes that. The
 * folder is private to this export and removed afterwards, printed or not.
 */
export async function printHtmlToPdf(html: string): Promise<Buffer> {
  const { BrowserWindow: Win } = require("electron") as typeof import("electron");
  const dir = await mkdtemp(join(tmpdir(), "atag-chat-export-"));
  const file = join(dir, "chat.html");
  // The file's own URL, compared by its tail: drive letters and slashes are spelled differently per OS.
  const own = `/${basename(dir)}/chat.html`.toLowerCase();
  const isOwn = (url: string): boolean => {
    if (!url.startsWith("file:")) return false;
    try { return decodeURIComponent(url).replace(/\\/g, "/").toLowerCase().endsWith(own); } catch { return false; }
  };
  let w: InstanceType<typeof Win> | null = null;
  try {
    await writeFile(file, html, { encoding: "utf8", mode: 0o600 });
    w = new Win({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "atag-chat-export" },
    });
    // Only the export file itself may load (the CSP already says so; this is the second lock).
    w.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isOwn(details.url) }));
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (event) => event.preventDefault());
    await w.loadFile(file);
    return await w.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
  } finally {
    if (w) w.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function registerChatExportIpc(deps: ChatExportDeps): void {
  deps.ipcMain.handle("agent:exportSession", (_event, id: unknown) => exportChatToFile(deps, id));
}
