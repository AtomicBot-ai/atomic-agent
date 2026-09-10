import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  buildAttachmentUserMessage,
  createAttachmentInbox,
  formatAttachmentsBlock,
  formatBytes,
  sanitizeFilename,
} from "./inbox.js";

const FIXED = new Date(2026, 8, 8, 14, 30, 12);

describe("AttachmentInbox.save", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-inbox-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes under <dir>/<date>/<time>-<name> and reports what it wrote", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => FIXED });
    const bytes = new Uint8Array([1, 2, 3]);
    const saved = await inbox.save({
      name: "report.pdf",
      mimeType: "application/pdf",
      bytes,
    });
    expect(saved.path).toBe(join(dir, "2026-09-08", "143012-report.pdf"));
    expect(saved.name).toBe("143012-report.pdf");
    expect(saved.bytes).toBe(3);
    expect(saved.mimeType).toBe("application/pdf");
    expect(readFileSync(saved.path)).toEqual(Buffer.from(bytes));
  });

  it("never overwrites: a second file in the same second gets a -2 suffix", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => FIXED });
    const first = await inbox.save({
      name: "a.txt",
      bytes: new Uint8Array([1]),
    });
    const second = await inbox.save({
      name: "a.txt",
      bytes: new Uint8Array([2]),
    });
    const third = await inbox.save({
      name: "a.txt",
      bytes: new Uint8Array([3]),
    });
    expect(basename(first.path)).toBe("143012-a.txt");
    expect(basename(second.path)).toBe("143012-a-2.txt");
    expect(basename(third.path)).toBe("143012-a-3.txt");
    expect(readFileSync(first.path)[0]).toBe(1);
    expect(readFileSync(second.path)[0]).toBe(2);
  });

  it("infers the extension from the MIME type when the name has none", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => FIXED });
    const saved = await inbox.save({
      name: "voice message",
      mimeType: "audio/ogg; codecs=opus",
      bytes: new Uint8Array([1]),
    });
    expect(basename(saved.path)).toBe("143012-voice_message.ogg");
    expect(saved.mimeType).toBe("audio/ogg");
  });

  it("falls back to the platform kind for both name and extension", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => FIXED });
    const saved = await inbox.save({
      kind: "photo",
      bytes: new Uint8Array([1]),
    });
    expect(basename(saved.path)).toBe("143012-photo.jpg");
    // No MIME reported — inferred back from the extension we chose.
    expect(saved.mimeType).toBe("image/jpeg");
  });

  it("keeps a path-traversal name inside the inbox", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => FIXED });
    const saved = await inbox.save({
      name: "../../../etc/passwd",
      bytes: new Uint8Array([1]),
    });
    expect(dirname(saved.path)).toBe(join(dir, "2026-09-08"));
    expect(basename(saved.path)).toBe("143012-passwd");
    expect(existsSync(join(dir, "..", "etc", "passwd"))).toBe(false);
  });

  it("uses `file` when nothing usable is left of the name and no kind is known", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => FIXED });
    const saved = await inbox.save({ name: "...", bytes: new Uint8Array([1]) });
    expect(basename(saved.path)).toBe("143012-file");
    expect(saved.mimeType).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("strips directories, control chars and Windows-hostile punctuation", () => {
    expect(sanitizeFilename("C:\\Users\\me\\my: file?.txt")).toBe(
      "my__file_.txt",
    );
    expect(sanitizeFilename("a\u0000b\u001fc.png")).toBe("abc.png");
    expect(sanitizeFilename("  spaced   name .jpg")).toBe("spaced_name_.jpg");
  });

  it("drops leading dots so a dotfile or `..` can never be created", () => {
    expect(sanitizeFilename(".env")).toBe("env");
    expect(sanitizeFilename("..")).toBeNull();
  });

  it("caps the length but keeps the extension", () => {
    const long = `${"x".repeat(200)}.tar.gz`;
    const out = sanitizeFilename(long)!;
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".gz")).toBe(true);
  });

  it("returns null for empty or non-string input", () => {
    expect(sanitizeFilename(undefined)).toBeNull();
    expect(sanitizeFilename("")).toBeNull();
    expect(sanitizeFilename("   ")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("picks the unit by magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
  });
});

describe("attachments block + user message", () => {
  const saved = {
    status: "saved" as const,
    saved: {
      path: "/inbox/2026-09-08/143012-photo.jpg",
      name: "143012-photo.jpg",
      bytes: 2048,
      mimeType: "image/jpeg",
    },
  };
  const failed = {
    status: "failed" as const,
    name: "big.zip",
    reason: "too big",
  };

  it("lists saved files with type and size, failures with the reason", () => {
    expect(formatAttachmentsBlock([saved, failed])).toBe(
      [
        "[attachments]",
        "- /inbox/2026-09-08/143012-photo.jpg (image/jpeg, 2 KB)",
        "- big.zip: not saved (too big)",
      ].join("\n"),
    );
  });

  it("leads with the caption and ends with the tool hint when something was saved", () => {
    const msg = buildAttachmentUserMessage("  what is this?  ", [saved]);
    expect(msg.startsWith("what is this?\n\n[attachments]\n")).toBe(true);
    expect(msg).toContain("vision.describe");
  });

  it("substitutes a stand-in line when there is no caption", () => {
    expect(buildAttachmentUserMessage(undefined, [saved])).toMatch(
      /^The user sent a file without a message\.\n\n\[attachments\]/,
    );
    expect(buildAttachmentUserMessage("", [saved, saved])).toMatch(
      /^The user sent 2 files without a message\./,
    );
  });

  it("omits the tool hint when nothing was saved", () => {
    const msg = buildAttachmentUserMessage("see attached", [failed]);
    expect(msg).not.toContain("os.fs.read");
    expect(msg).toContain("big.zip: not saved (too big)");
  });
});
