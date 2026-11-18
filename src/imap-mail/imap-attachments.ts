import { extname } from "node:path";

import {
  sanitizeFilename,
  type AttachmentInbox,
  type AttachmentOutcome,
} from "../channels/attachments/inbox.js";
import type { ImapAttachmentLimits } from "../config/imap-trigger-config.js";
import type { MailAttachmentPart } from "./imap-message.js";

/**
 * Which files of a mail task (ATO-601) land on disk, and where. Saved
 * through the same attachment inbox the chat channels use
 * (`<stateDir>/inbox/email/<binding>/<day>/...`), so the agent gets
 * paths it reads with `os.fs.read`, `read_document` or `vision.describe`,
 * and the task's message names them, which also puts them in the
 * session's read scope.
 *
 * Executables, installers, scripts, disk images and macro documents are
 * never written (by extension, MIME type, or an executable header in a
 * file with no extension), the same families Gmail and Outlook block.
 * The count, per-file and per-mail size caps come from config.
 */

const BLOCKED_EXTENSIONS = new Set([
  // Windows executables, installers and shortcuts
  ".exe", ".com", ".scr", ".pif", ".cpl", ".msi", ".msp", ".mst", ".msc", ".dll", ".sys", ".lnk", ".url",
  ".reg", ".inf", ".gadget", ".appx", ".appxbundle", ".msix", ".application", ".xll", ".hta", ".chm",
  // scripts
  ".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".js", ".jse", ".mjs", ".cjs", ".wsf", ".wsh",
  ".wsc", ".sct", ".sh", ".bash", ".zsh", ".csh", ".ksh", ".command", ".tool", ".py", ".pyw", ".pl", ".rb",
  ".php", ".jar", ".scpt", ".applescript", ".workflow", ".action",
  // macOS and Linux packages and images
  ".app", ".pkg", ".mpkg", ".dmg", ".iso", ".img", ".vhd", ".vhdx", ".deb", ".rpm", ".apk", ".appimage",
  ".run", ".bin", ".elf", ".so", ".dylib", ".kext",
  // Office documents with macros
  ".docm", ".dotm", ".xlsm", ".xltm", ".xlam", ".pptm", ".potm", ".ppam", ".ppsm", ".sldm",
]);

const BLOCKED_MIME = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-ms-installer",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sh",
  "application/x-csh",
  "application/x-shellscript",
  "application/x-bat",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/java-archive",
  "application/x-java-archive",
  "application/x-apple-diskimage",
  "application/hta",
  "application/vnd.ms-office.vbaproject",
]);

/** MZ (Windows), ELF, Mach-O (both byte orders, fat), `#!` scripts. */
function looksExecutable(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const b = bytes;
  if (b[0] === 0x4d && b[1] === 0x5a) return true;
  if (b[0] === 0x23 && b[1] === 0x21) return true;
  if (b.length < 4) return false;
  const magic = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return (
    magic === 0x7f454c46 ||
    magic === 0xfeedface || magic === 0xfeedfacf ||
    magic === 0xcefaedfe || magic === 0xcffaedfe ||
    magic === 0xcafebabe
  );
}

/** Why a file is not saved on its type, or `null` when its type is fine. */
export function blockedAttachmentReason(part: Pick<MailAttachmentPart, "name" | "mimeType" | "bytes">): string | null {
  // Trailing dots and spaces are dropped by Windows: `x.exe.` is `x.exe`.
  const name = part.name.trim().replace(/[.\s]+$/, "").toLowerCase();
  const ext = extname(name);
  if (BLOCKED_EXTENSIONS.has(ext)) return `blocked file type ${ext}`;
  const mime = part.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (BLOCKED_MIME.has(mime)) return `blocked file type ${mime}`;
  if (looksExecutable(part.bytes)) return "blocked: the file is a program";
  return null;
}

/**
 * Saves what the limits allow, in mail order, and reports every file:
 * saved, or not saved with the reason (shown to the agent, so "the
 * mail had an .exe" is visible rather than silently missing).
 */
export async function saveMailAttachments(
  parts: readonly MailAttachmentPart[],
  limits: ImapAttachmentLimits,
  inbox: AttachmentInbox,
): Promise<AttachmentOutcome[]> {
  const outcomes: AttachmentOutcome[] = [];
  let saved = 0;
  let total = 0;
  for (const part of parts) {
    const label = sanitizeFilename(part.name) ?? "(unnamed)";
    const refuse = (reason: string) => outcomes.push({ status: "failed", name: label, reason });
    if (!limits.save) {
      refuse("attachments are not saved for this binding");
      continue;
    }
    const blocked = blockedAttachmentReason(part);
    if (blocked) {
      refuse(blocked);
      continue;
    }
    if (saved >= limits.maxCount) {
      refuse(`over the limit of ${limits.maxCount} files per mail`);
      continue;
    }
    if (part.bytes.byteLength > limits.maxBytes) {
      refuse(`larger than ${limits.maxBytes} bytes`);
      continue;
    }
    if (total + part.bytes.byteLength > limits.maxTotalBytes) {
      refuse(`over the limit of ${limits.maxTotalBytes} bytes per mail`);
      continue;
    }
    try {
      const file = await inbox.save({
        name: part.name || undefined,
        mimeType: part.mimeType,
        bytes: part.bytes,
        kind: "file",
      });
      saved += 1;
      total += part.bytes.byteLength;
      outcomes.push({ status: "saved", saved: file });
    } catch (err) {
      refuse(`could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return outcomes;
}
