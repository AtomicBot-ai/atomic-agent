import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAttachmentInbox } from "../channels/attachments/inbox.js";
import { IMAP_ATTACHMENT_DEFAULTS } from "../config/imap-trigger-config.js";
import { blockedAttachmentReason, saveMailAttachments } from "./imap-attachments.js";

const file = (name: string, text = "data", mimeType = "application/octet-stream") => ({
  name,
  mimeType,
  bytes: Buffer.from(text),
});

describe("blockedAttachmentReason (ATO-601)", () => {
  it.each([
    ["setup.exe", "application/octet-stream", "x"],
    ["invoice.pdf.exe", "application/pdf", "x"],
    ["Run.EXE. ", "application/octet-stream", "x"],
    ["build.sh", "text/plain", "x"],
    ["macro.xlsm", "application/vnd.ms-excel", "x"],
    ["disk.dmg", "application/octet-stream", "x"],
    ["noext", "application/x-msdownload", "x"],
    ["noext", "application/octet-stream", "MZ\u0090\u0000"],
    ["noext", "application/octet-stream", "\u007fELF\u0002"],
    ["notes.txt", "text/plain", "#!/bin/sh\nrm -rf ~"],
  ])("blocks %s (%s)", (name, mime, text) => {
    expect(blockedAttachmentReason({ name, mimeType: mime, bytes: Buffer.from(text, "latin1") })).not.toBeNull();
  });

  it.each([
    ["report.pdf", "application/pdf"],
    ["photo.jpg", "image/jpeg"],
    ["data.csv", "text/csv"],
    ["archive.zip", "application/zip"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ])("allows %s", (name, mime) => {
    expect(blockedAttachmentReason({ name, mimeType: mime, bytes: Buffer.from("plain") })).toBeNull();
  });
});

describe("saveMailAttachments (ATO-601)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "imap-att-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saves allowed files under the inbox and reports the rest with a reason", async () => {
    const inbox = createAttachmentInbox({ dir, now: () => new Date(2026, 10, 18, 9, 30, 0) });
    const outcomes = await saveMailAttachments(
      [file("../../etc/report.pdf", "pdf"), file("tool.exe"), file("big.bin", "x".repeat(20)), file("b.txt", "bb"), file("c.txt", "cc")],
      { save: true, maxCount: 2, maxBytes: 10, maxTotalBytes: 100 },
      inbox,
    );
    expect(outcomes.map((o) => o.status)).toEqual(["saved", "failed", "failed", "saved", "failed"]);
    const saved = outcomes[0]!;
    if (saved.status !== "saved") throw new Error("expected saved");
    expect(saved.saved.path.startsWith(join(dir, "2026-11-18"))).toBe(true);
    expect(saved.saved.name).toBe("093000-report.pdf");
    expect(readFileSync(saved.saved.path, "utf8")).toBe("pdf");
    expect(outcomes[1]).toMatchObject({ status: "failed", reason: expect.stringMatching(/blocked/) });
    expect(outcomes[2]).toMatchObject({ status: "failed", reason: expect.stringMatching(/larger than/) });
    expect(outcomes[4]).toMatchObject({ status: "failed", reason: expect.stringMatching(/2 files/) });
  });

  it("keeps the per-mail total", async () => {
    const inbox = createAttachmentInbox({ dir });
    const outcomes = await saveMailAttachments(
      [file("a.txt", "12345"), file("b.txt", "12345"), file("c.txt", "1")],
      { save: true, maxCount: 10, maxBytes: 10, maxTotalBytes: 10 },
      inbox,
    );
    expect(outcomes.map((o) => o.status)).toEqual(["saved", "saved", "failed"]);
  });

  it("writes nothing when saving is off", async () => {
    const inbox = createAttachmentInbox({ dir });
    const outcomes = await saveMailAttachments([file("a.pdf")], { ...IMAP_ATTACHMENT_DEFAULTS, save: false }, inbox);
    expect(outcomes).toEqual([{ status: "failed", name: "a.pdf", reason: expect.stringMatching(/not saved/) }]);
  });
});
