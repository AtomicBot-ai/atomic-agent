import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasArchiveHead, isArchiveBytes } from "./guest-archives.js";
import { checkGuestRead } from "./guest-reads.js";

/**
 * ATO-2805, review round 2: a guest got the `.env` inside `backup.zip`
 * without `read_entry`, as a `reply` attachment or by reading the
 * archive's bytes. A guest's call now refuses any archive, by name or
 * by bytes, outside the two archive tools (which judge entries).
 */
const TAR_FIXTURE = resolve(
  fileURLToPath(new URL("../os/test-fixtures/sample.tar", import.meta.url)),
);

/** A one-entry old-style (v7) tar: no `ustar` magic, only a checksum. */
function v7Tar(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const data = Buffer.alloc(512);
  data.write(body, 0, "utf8");
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

/** A one-entry binary cpio header, its magic and name size in `order`. */
function binaryCpio(order: "le" | "be", name: string): Buffer {
  const header = Buffer.alloc(26);
  const put = (value: number, at: number) =>
    order === "le" ? header.writeUInt16LE(value, at) : header.writeUInt16BE(value, at);
  put(0o070707, 0);
  put(0o100644, 6);
  put(1, 12);
  put(name.length + 1, 20);
  return Buffer.concat([header, Buffer.from(`${name}\0`, "ascii"), Buffer.from("API_KEY=x\n")]);
}

let home: string;
let work: string;
const guest = () => ({ guest: true as const, workingDir: work });
const options = () => ({ home, stateDir: join(home, ".atomic-agent") });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "guest-archives-"));
  work = join(home, "project");
  mkdirSync(join(work, "folder.zip"), { recursive: true });
  const zip = new JSZip();
  zip.file("config/.env", "API_KEY=sk-live-guest-must-not-see\n");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(join(work, "outer-with-env.zip"), bytes);
  // The same archive under names that hide what it is.
  writeFileSync(join(work, "notes.txt"), bytes);
  writeFileSync(join(work, "photo.png"), bytes);
  writeFileSync(join(work, "prefixed.txt"), Buffer.concat([Buffer.from("#!/bin/sh\nexit 0\n"), bytes]));
  writeFileSync(join(work, "backup.tar"), readFileSync(TAR_FIXTURE));
  writeFileSync(join(work, "plain.dat"), readFileSync(TAR_FIXTURE));
  writeFileSync(join(work, "old.dat"), v7Tar("config/.env", "API_KEY=x\n"));
  writeFileSync(join(work, "report.docx"), bytes);
  writeFileSync(join(work, "README.md"), "hello\n");
  // Review round 3: text that starts like a short cpio or bzip2 magic.
  writeFileSync(join(work, "zip-codes.csv"), "07070 Rutherford NJ\n07071 Lyndhurst NJ\n");
  writeFileSync(join(work, "bzh-notes.txt"), "BZh9 is how a bzip2 file starts\n");
  writeFileSync(join(work, "packed.dat"), Buffer.from(`070707${"0".repeat(70)}.env\0API_KEY=x\n`, "ascii"));
  writeFileSync(join(work, "letter.docx"), "not a zip at all\n");
  writeFileSync(join(work, "book.xlsx"), bytes);
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("a guest and archives (ATO-2805)", () => {
  it("refuses an archive as a reply attachment, by name and by bytes", () => {
    for (const file of ["outer-with-env.zip", "notes.txt", "photo.png", "backup.tar", "report.docx"]) {
      expect(checkGuestRead("reply", { message: "here", attachments: [file] }, guest(), options()), file).not.toBeNull();
    }
    expect(checkGuestRead("reply", { message: "here", attachments: ["README.md"] }, guest(), options())).toBeNull();
  });

  it("refuses raw reads of a plain tar, a stored zip and a zip behind a prefix", () => {
    for (const path of ["backup.tar", "plain.dat", "old.dat", "notes.txt", "prefixed.txt", "outer-with-env.zip"]) {
      expect(checkGuestRead("os.fs.read", { path }, guest(), options()), path).not.toBeNull();
    }
    expect(checkGuestRead("os.fs.grep", { pattern: "API_KEY", path: "backup.tar" }, guest(), options())).not.toBeNull();
    expect(checkGuestRead("os.fs.diff", { aPath: "README.md", bPath: "notes.txt" }, guest(), options())).not.toBeNull();
    expect(checkGuestRead("vision.describe", { path: "photo.png" }, guest(), options())).not.toBeNull();
    expect(checkGuestRead("os.fs.read", { path: "README.md" }, guest(), options())).toBeNull();
  });

  it("leaves the archive tools, name-only tools, folders and the document extractor alone", () => {
    expect(checkGuestRead("os.fs.archive.read_entry", { path: "outer-with-env.zip", entry: "README.md" }, guest(), options())).toBeNull();
    expect(checkGuestRead("os.fs.archive.list", { path: "notes.txt" }, guest(), options())).toBeNull();
    expect(checkGuestRead("os.fs.hash", { path: "backup.tar" }, guest(), options())).toBeNull();
    expect(checkGuestRead("os.fs.grep", { pattern: "x", path: "folder.zip" }, guest(), options())).toBeNull();
    expect(checkGuestRead("os.fs.read_document", { path: "report.docx" }, guest(), options())).toBeNull();
    // `plain` reads the container as text.
    expect(checkGuestRead("os.fs.read_document", { path: "report.docx", format: "plain" }, guest(), options())).not.toBeNull();
    expect(checkGuestRead("os.fs.read_document", { path: "backup.tar", format: "plain" }, guest(), options())).not.toBeNull();
  });

  it("lets a guest read text that starts like a cpio or bzip2 magic (review round 3)", () => {
    for (const path of ["zip-codes.csv", "bzh-notes.txt"]) {
      expect(checkGuestRead("os.fs.read", { path }, guest(), options()), path).toBeNull();
      expect(checkGuestRead("reply", { message: "here", attachments: [path] }, guest(), options()), path).toBeNull();
    }
    expect(checkGuestRead("os.fs.read", { path: "packed.dat" }, guest(), options())).not.toBeNull();
  });

  it("still knows real cpio and bzip2 headers", () => {
    for (const magic of ["070701", "070702", "070707"]) {
      expect(hasArchiveHead(Buffer.from(magic + "0".repeat(104), "ascii")), magic).toBe(true);
    }
    expect(hasArchiveHead(binaryCpio("le", ".env")), "binary cpio, little-endian").toBe(true);
    expect(hasArchiveHead(binaryCpio("be", ".env")), "binary cpio, big-endian").toBe(true);
    // `printf hello | bzip2` and an empty `bzip2` stream.
    expect(hasArchiveHead(Buffer.from("425a6839314159265359c1c080e2000001410000100244a00030cd00c346", "hex"))).toBe(true);
    expect(hasArchiveHead(Buffer.from("425a683917724538509000000000", "hex"))).toBe(true);
    for (const text of ["07070 Rutherford NJ\n", "070700\n", "BZh is a prefix\n", "BZh9 hello\n", "BZh0" + "1AY&SY"]) {
      expect(hasArchiveHead(Buffer.from(text, "ascii")), text).toBe(false);
    }
    // The binary magic followed by text: the name size is not a cpio one.
    expect(hasArchiveHead(Buffer.from("\u00c7q and then just a line of text\n", "latin1"))).toBe(false);
  });

  it("refuses an office name on any bytes, and lets os.fs.xlsx read a workbook", () => {
    // By name alone: the bytes are text.
    expect(checkGuestRead("os.fs.read", { path: "letter.docx" }, guest(), options())).not.toBeNull();
    expect(checkGuestRead("os.fs.xlsx", { path: "book.xlsx", op: "read" }, guest(), options())).toBeNull();
    expect(checkGuestRead("os.fs.xlsx", { path: "book.xlsx", op: "write", rows: [["a"]] }, guest(), options())).not.toBeNull();
    expect(checkGuestRead("os.fs.read", { path: "book.xlsx" }, guest(), options())).not.toBeNull();
    // Not a workbook name: the bytes still refuse it.
    expect(checkGuestRead("os.fs.xlsx", { path: "notes.txt", op: "read" }, guest(), options())).not.toBeNull();
  });

  it("does not touch the owner", () => {
    expect(checkGuestRead("os.fs.read", { path: "backup.tar" }, { workingDir: work }, options())).toBeNull();
    expect(checkGuestRead("reply", { attachments: ["outer-with-env.zip"] }, { workingDir: work }, options())).toBeNull();
  });

  it("detects archive bytes but not text", () => {
    expect(isArchiveBytes(readFileSync(TAR_FIXTURE))).toBe(true);
    expect(isArchiveBytes(v7Tar("a.txt", "hi"))).toBe(true);
    expect(hasArchiveHead(Buffer.from("API_KEY=x\nhello world\n"))).toBe(false);
    expect(isArchiveBytes(Buffer.from("# README\n\nplain text, nothing packed\n"))).toBe(false);
  });
});
