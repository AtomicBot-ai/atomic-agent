/**
 * ATO-404 / ATO-405 — the composer's attachment routes.
 *
 *   attachments:pick     the open dialog (images or files) → [{path, name, size}]
 *   attachments:readPicked  the bytes of an image the dialog picked, for the
 *                        window to downscale (only a path this dialog returned)
 *   attachments:save     a picked path or bytes the window holds → saved into
 *                        the inbox (attachments.ts saveAttachment)
 *   attachments:discard  a chip removed before sending: its inbox file goes
 *   attachments:check / attachments:open  a sent file in the inbox: still
 *                        there? / opened, never run (reply-paths.ts rules, with
 *                        the inbox as the only folder allowed). The state dir
 *                        need not be under the home folder, which is all
 *                        `app:openReplyPath` allows.
 *
 * The window never names an arbitrary path to read: a path is only accepted
 * when this process's own dialog returned it. A drop and a paste hand over
 * bytes (the window has them: a dropped File, a clipboard image).
 */

import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { discardAttachment, inboxDir, readPickedImage, saveAttachment, type AttachmentSource } from "./attachments.js";
import { replyPathVerdict } from "./reply-paths.js";

/** The open dialog's two filters, mirroring renderer/attachments.js. */
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
const FILE_EXTS = [
  "pdf", "docx", "txt", "md", "csv", "xlsx", "xls", "ods", "pptx", "html", "htm",
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "py", "pyw", "pyi", "c", "h", "cpp", "cc", "cxx", "hpp", "hh",
  "rs", "go", "swift", "zig", "java", "kt", "kts", "scala", "groovy", "rb", "php", "lua", "pl", "r", "jl",
  "cs", "fs", "vb", "sh", "bash", "zsh", "fish", "ps1", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "env", "sql", "graphql", "gql", "tex", "rst",
  "log", "diff", "patch",
];

/**
 * TEST ONLY — `--fake-pick=<file.json>` (test/attachments-images.drive.mjs):
 * the open dialog is not shown, and `attachments:pick` answers with the
 * paths that file lists, `{"images": [...], "files": [...]}`, read on every
 * pick. A flag a shipped launch never passes, like `--fake-ram`.
 */
function fakePick(kind: "images" | "files"): string[] | null {
  const hit = process.argv.find((a) => a.startsWith("--fake-pick="));
  if (!hit) return null;
  try {
    const list = (JSON.parse(readFileSync(hit.slice("--fake-pick=".length), "utf8")) as Record<string, unknown>)[kind];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** At most this many paths a dialog returned are remembered (a long session picks a lot). */
const PICKED_MAX = 500;

export function wireAttachmentIpc(opts: { window: () => BrowserWindow | null; stateDir: string }): void {
  const picked = new Set<string>();
  const remember = (p: string) => {
    picked.add(p);
    if (picked.size > PICKED_MAX) picked.delete(picked.values().next().value as string);
  };

  ipcMain.handle("attachments:pick", async (_event, kind: unknown) => {
    const images = kind === "images";
    const fake = fakePick(images ? "images" : "files");
    const win = opts.window();
    if (!win && !fake) return [];
    const res = fake ? { canceled: false, filePaths: fake } : await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      message: images ? "Choose images to attach" : "Choose files to attach",
      filters: images
        ? [{ name: "Images", extensions: IMAGE_EXTS }]
        : [{ name: "Documents and code", extensions: FILE_EXTS }, { name: "All files", extensions: ["*"] }],
    });
    if (res.canceled) return [];
    const out: Array<{ path: string; name: string; size: number | null }> = [];
    for (const p of res.filePaths) {
      remember(p);
      let size: number | null = null;
      try { size = (await stat(p)).size; } catch { /* the save reports it */ }
      out.push({ path: p, name: basename(p), size });
    }
    return out;
  });

  ipcMain.handle("attachments:readPicked", async (_event, p: unknown) => {
    if (typeof p !== "string" || !picked.has(p)) return { ok: false, error: "The file could not be read" };
    return readPickedImage(p);
  });

  ipcMain.handle("attachments:save", async (_event, payload: unknown) => {
    const src = (payload ?? {}) as { path?: unknown; bytes?: unknown; name?: unknown; mimeType?: unknown };
    const name = typeof src.name === "string" ? src.name : undefined;
    let source: AttachmentSource;
    if (typeof src.path === "string") {
      if (!picked.has(src.path)) return { ok: false, reason: "unreadable", error: "The file could not be read" };
      source = { path: src.path, ...(name ? { name } : {}) };
    } else if (src.bytes instanceof Uint8Array || src.bytes instanceof ArrayBuffer) {
      const bytes = src.bytes instanceof ArrayBuffer ? new Uint8Array(src.bytes) : src.bytes;
      source = { bytes, ...(name ? { name } : {}) };
    } else {
      return { ok: false, reason: "unreadable", error: "The file could not be read" };
    }
    try {
      return await saveAttachment(opts.stateDir, source);
    } catch {
      return { ok: false, reason: "unreadable", error: "The file could not be saved" };
    }
  });

  ipcMain.handle("attachments:discard", (_event, p: unknown) =>
    typeof p === "string" ? discardAttachment(opts.stateDir, p) : false,
  );

  const inboxVerdict = (p: unknown) => replyPathVerdict(p, inboxDir(opts.stateDir), process.platform);
  ipcMain.handle("attachments:check", async (_event, p: unknown) => {
    const v = await inboxVerdict(p);
    return { ok: v.ok, why: v.why ?? null };
  });
  ipcMain.handle("attachments:open", async (_event, p: unknown) => {
    const v = await inboxVerdict(p);
    if (!v.ok || !v.abs) return { ok: false, why: v.why, error: v.why === "missing" ? "It is no longer there." : "Not a file in the attachments folder." };
    if (v.reveal) { shell.showItemInFolder(v.abs); return { ok: true, revealed: true }; }
    const err = await shell.openPath(v.abs);
    return err ? { ok: false, why: "failed", error: err } : { ok: true };
  });
}
