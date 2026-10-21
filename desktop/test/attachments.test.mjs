// Unit tests for ATO-403 attachments: main/attachments.ts (against the built
// output) and the pure half of renderer/attachments.js.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/attachments.js");
const R = require("../renderer/attachments.js");
const V = require("../out/main/analytics/validate.js");

const state = mkdtempSync(join(tmpdir(), "att-state-"));
const outside = mkdtempSync(join(tmpdir(), "att-outside-"));
after(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PDF = new TextEncoder().encode("%PDF-1.7\n...");
const at = () => new Date(2026, 9, 14, 9, 5, 7);

test("the block and the message are byte-identical to the channel inbox's", () => {
  const items = [
    { path: "/s/inbox/desktop/2026-10-14/090507-a.png", mimeType: "image/png", bytes: 122880 },
    { path: "/s/inbox/desktop/2026-10-14/090507-b.pdf", mimeType: null, bytes: 3 * 1024 * 1024 + 7 },
  ];
  const outcomes = items.map((i) => ({ status: "saved", saved: { path: i.path, mimeType: i.mimeType, bytes: i.bytes } }));
  const want = M.buildAttachmentUserMessage("look at these", outcomes);
  assert.equal(R.attBuildMessage("look at these", items), want);
  assert.equal(want, [
    "look at these", "",
    "[attachments]",
    "- /s/inbox/desktop/2026-10-14/090507-a.png (image/png, 120 KB)",
    "- /s/inbox/desktop/2026-10-14/090507-b.pdf (unknown type, 3.0 MB)",
    M.HINT_LINE,
  ].join("\n"));
  assert.equal(R.ATT_HINT_LINE, M.HINT_LINE);
  assert.match(M.HINT_LINE, /os\.fs\.archive\.list/);
  // No caption: the channels' stand-in.
  assert.equal(R.attBuildMessage("  ", items.slice(0, 1)), M.buildAttachmentUserMessage(undefined, outcomes.slice(0, 1)));
  assert.match(R.attBuildMessage("", items.slice(0, 1)), /^The user sent a file without a message\.\n/);
  assert.match(R.attBuildMessage("", items), /^The user sent 2 files without a message\.\n/);
});

test("a stored message splits back into its caption and files", () => {
  const items = [
    { path: "/Users/n/My Files (old)/inbox/desktop/2026-10-14/090507-shot one.png", mimeType: "image/png", bytes: 2048 },
    { path: "C:\\Users\\n\\.atomic-agent-desktop\\inbox\\desktop\\2026-10-14\\090507-notes.md", mimeType: "text/markdown", bytes: 10 },
  ];
  const s = R.attSplitMessage(R.attBuildMessage("line one\n\nline two", items));
  assert.equal(s.caption, "line one\n\nline two");
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].path, items[0].path);
  assert.equal(s.items[0].name, "shot one.png");
  assert.equal(s.items[0].kind, "image");
  assert.equal(s.items[1].kind, "document");
  assert.equal(s.items[1].size, "10 B");
  assert.equal(R.attSplitMessage(R.attBuildMessage("", items)).caption, "");
  // A message stored before archives were named in the hint line still splits.
  const v1 = R.attBuildMessage("old", items).replace(R.ATT_HINT_LINE,
    "The files are saved locally: read them with os.fs.read or os.fs.read_document; use vision.describe for images.");
  assert.equal(R.attSplitMessage(v1).items.length, 2);
  // Plain text, a typed block that this format did not write: drawn as typed.
  assert.equal(R.attSplitMessage("hello"), null);
  assert.equal(R.attSplitMessage("see\n\n[attachments]\nmy own list"), null);
  // The channels' failed line parses too, next to a file that landed.
  const failed = R.attSplitMessage(M.buildAttachmentUserMessage("x", [
    { status: "saved", saved: { path: "/s/inbox/telegram/2026-10-14/090507-a.jpg", mimeType: "image/jpeg", bytes: 5 } },
    { status: "failed", name: "big.zip", reason: "too large" },
  ]));
  assert.deepEqual(failed.items[1], { name: "big.zip", reason: "too large", failed: true });
  // Text that only looks like a block (paths outside an inbox, or nothing landed) is shown as typed.
  assert.equal(R.attSplitMessage(R.attBuildMessage("x", [{ path: "/etc/hosts", mimeType: "text/plain", bytes: 1 }])), null);
  assert.equal(R.attSplitMessage(M.buildAttachmentUserMessage("x", [{ status: "failed", name: "big.zip", reason: "too large" }])), null);
  assert.equal(R.attPlainText(R.attBuildMessage("", items)), "(2 files)");
  assert.equal(R.attPlainText(R.attBuildMessage("caption", items)), "caption");
  assert.equal(R.attQueueLabel(R.attBuildMessage("hi", items)), "hi · 2 files");
  assert.equal(R.attParseSize("120 KB"), 122880);
});

test("names classify as Atomic Chat's classifyDroppedPaths does", () => {
  const c = R.attClassifyDroppedPaths(["/a/x.PNG", "/a/y.jpeg", "/a/z.pdf", "/a/main.rs", "/a/song.mp3", "/a/Makefile", "/a/v.mov", "C:\\d\\e.webp"]);
  assert.deepEqual(c.images, ["/a/x.PNG", "/a/y.jpeg", "C:\\d\\e.webp"]);
  assert.deepEqual(c.docs, ["/a/z.pdf", "/a/main.rs"]);
  assert.deepEqual(c.audio, ["/a/song.mp3"]);
  assert.deepEqual(c.unsupported, ["/a/Makefile", "/a/v.mov"]);
  // Archives go by path for os.fs.archive.*; 7z and rar it cannot open.
  const a = R.attClassifyDroppedPaths(["/a/src.zip", "/a/logs.tar.gz", "/a/b.tgz", "/a/c.tar", "/a/d.7z", "/a/e.rar"]);
  assert.deepEqual(a.docs, ["/a/src.zip", "/a/logs.tar.gz", "/a/b.tgz", "/a/c.tar"]);
  assert.deepEqual(a.unsupported, ["/a/d.7z", "/a/e.rar"]);
  assert.equal(R.attSizeBucket(99 * 1024), "lt_100kb");
  assert.equal(R.attSizeBucket(10 * 1024 * 1024), "gte_10mb");
});

test("type comes from the bytes, not the name", () => {
  assert.equal(M.mimeFor(PNG, "photo.jpg"), "image/png");
  assert.equal(M.mimeFor(PDF, "report.txt"), "application/pdf");
  assert.equal(M.mimeFor(new TextEncoder().encode("# hi"), "a.md"), "text/markdown");
  assert.equal(M.mimeFor(new TextEncoder().encode("fn main(){}"), "main.rs"), "text/plain");
  assert.equal(M.mimeFor(Uint8Array.from([0x50, 0x4b, 3, 4, 0]), "d.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(M.mimeFor(Uint8Array.from([0, 1, 2, 3]), "fake.png"), null);
  assert.equal(M.mimeFor(Uint8Array.from([0x50, 0x4b, 3, 4, 0]), "src.zip"), "application/zip");
  assert.equal(M.mimeFor(Uint8Array.from([0x1f, 0x8b, 8, 0, 0]), "logs.tar.gz"), "application/gzip");
  assert.equal(M.mimeFor(Uint8Array.from([0x1f, 0x8b, 8, 0, 0]), "b.tgz"), "application/gzip");
  assert.equal(M.mimeFor(Uint8Array.from([0x61, 0, 0, 0]), "c.tar"), "application/x-tar");
  assert.equal(M.inboxBasename("photo.jpg", "image/png"), "photo.png");
  assert.equal(M.inboxBasename("../../etc/passwd", "text/plain"), "passwd.txt");
  assert.equal(M.inboxBasename("noext", "application/pdf"), "noext.pdf");
});

test("bytes land in <stateDir>/inbox/desktop/<day>/<HHMMSS>-<name>, never overwriting", async () => {
  const a = await M.saveAttachment(state, { bytes: PNG, name: "shot.jpg" }, at);
  assert.equal(a.ok, true);
  assert.equal(a.path, join(state, "inbox", "desktop", "2026-10-14", "090507-shot.png"));
  assert.equal(a.kind, "image");
  assert.equal(a.mimeType, "image/png");
  assert.deepEqual(new Uint8Array(readFileSync(a.path)), PNG);
  const b = await M.saveAttachment(state, { bytes: PNG, name: "shot.png" }, at);
  assert.equal(basename(b.path), "090507-shot-2.png");
});

test("a picked path is copied; folders, fakes and oversize files are refused", async () => {
  const src = join(outside, "Report Q3.pdf");
  writeFileSync(src, PDF);
  const r = await M.saveAttachment(state, { path: src }, at);
  assert.equal(r.ok, true);
  assert.equal(basename(r.path), "090507-Report_Q3.pdf");
  assert.equal(r.kind, "document");
  assert.equal(existsSync(src), true);

  mkdirSync(join(outside, "dir"));
  assert.equal((await M.saveAttachment(state, { path: join(outside, "dir") }, at)).reason, "not-a-file");
  assert.equal((await M.saveAttachment(state, { path: join(outside, "nope.pdf") }, at)).reason, "unreadable");
  assert.equal((await M.saveAttachment(state, { bytes: Uint8Array.from([1, 2, 0, 3]), name: "x.jpg" }, at)).reason, "not-an-image");

  const bigImg = new Uint8Array(M.IMAGE_MAX_BYTES + 1); bigImg.set(JPEG);
  const big = await M.saveAttachment(state, { bytes: bigImg, name: "huge.jpg" }, at);
  assert.equal(big.reason, "too-large");
  assert.match(big.error, /10 MB/);
  const bigDoc = join(outside, "huge.log");
  writeFileSync(bigDoc, Buffer.alloc(M.DOCUMENT_MAX_BYTES + 1, 0x61));
  assert.equal((await M.saveAttachment(state, { path: bigDoc }, at)).reason, "too-large");
});

test("discard removes only a file inside this desktop's inbox", async () => {
  const a = await M.saveAttachment(state, { bytes: JPEG, name: "gone.jpg" }, at);
  assert.equal(await M.discardAttachment(state, a.path), true);
  assert.equal(existsSync(a.path), false);
  const keep = join(outside, "keep.txt");
  writeFileSync(keep, "x");
  assert.equal(await M.discardAttachment(state, keep), false);
  assert.equal(await M.discardAttachment(state, join(state, "inbox", "desktop", "..", "..", "x")), false);
  assert.equal(existsSync(keep), true);
});

test("attachment_added carries a kind, a size bucket and a method, nothing else", () => {
  const ok = V.validateEvent("attachment_added", { kind: "image", size: "lt_1mb", method: "paste", name: "secret.png" }, "ui").props;
  assert.deepEqual(ok, { kind: "image", size: "lt_1mb", method: "paste" });
});

test("a file dropped while Settings is open does not attach to the chat underneath (ATO-602)", () => {
  assert.equal(R.attDropAllowed({ hasComposer: true, wizardOpen: false, settingsOpen: false }), true);
  assert.equal(R.attDropAllowed({ hasComposer: true, wizardOpen: false, settingsOpen: true }), false);
  assert.equal(R.attDropAllowed({ hasComposer: true, wizardOpen: true, settingsOpen: false }), false);
  assert.equal(R.attDropAllowed({ hasComposer: false, wizardOpen: false, settingsOpen: false }), false);
});

test("a file dropped over the palette, a sheet or the delete alert does not attach to the chat underneath (ATO-774)", () => {
  const base = { hasComposer: true, wizardOpen: false, settingsOpen: false };
  assert.equal(R.attDropAllowed({ ...base, modalOpen: true }), false);
  // A popover pinned to the composer (model, modes, context) leaves modalOpen false.
  assert.equal(R.attDropAllowed({ ...base, modalOpen: false }), true);
  assert.equal(R.attDropAllowed(base), true);
});
