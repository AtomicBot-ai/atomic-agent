import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  StructuredLogger,
  type LogRecord,
} from "../../tracing/structured-logger.js";
import { loadImageFile, UnsupportedImageFormatError } from "./load-image.js";

const ascii = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0));

/**
 * Fixtures are assembled from magic bytes in-test rather than checked in
 * as binaries: the header is the whole subject, and a `.png` in the repo
 * would hide the one detail every case turns on.
 */
function imageBytes(header: number[]): Buffer {
  const body = Buffer.alloc(48, 0xa5);
  return Buffer.concat([Buffer.from(header), body]);
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = ascii("GIF89a");
const WEBP = [...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBP")];

let dir: string;
let records: LogRecord[];
let logger: StructuredLogger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "load-image-"));
  records = [];
  logger = new StructuredLogger({
    level: "debug",
    sinks: [(record) => records.push(record)],
  });
});

async function write(name: string, bytes: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

describe("loadImageFile", () => {
  const matching: Array<{ name: string; header: number[]; mime: string }> = [
    { name: "shot.png", header: PNG, mime: "image/png" },
    { name: "shot.jpg", header: JPEG, mime: "image/jpeg" },
    { name: "shot.jpeg", header: JPEG, mime: "image/jpeg" },
    { name: "shot.gif", header: GIF, mime: "image/gif" },
    { name: "shot.webp", header: WEBP, mime: "image/webp" },
  ];

  for (const { name, header, mime } of matching) {
    it(`types ${name} as ${mime} when name and bytes agree`, async () => {
      const path = await write(name, imageBytes(header));
      const loaded = await loadImageFile(path, dir, { logger });
      expect(loaded.mimeType).toBe(mime);
      expect(loaded.mimeTypeSource).toBe("bytes");
      expect(loaded.path).toBe(path);
      // An agreeing pair is the normal case — it must stay silent.
      expect(records).toHaveLength(0);
    });
  }

  // The headline case. Telegram and Discord hand the inbox a
  // client-chosen filename, the inbox writes it verbatim
  // (`attachmentBasename` in src/channels/attachments/inbox.ts returns a
  // stem that already has an extension unchanged), and a PNG screenshot
  // lands as `photo.jpg`. Typing that from the extension put
  // `data:image/jpeg;base64,<PNG>` on the wire in
  // `describeImageViaOpenAi` and earned an opaque provider 400.
  it("types PNG bytes in a .jpg file as image/png", async () => {
    const path = await write("photo.jpg", imageBytes(PNG));
    const loaded = await loadImageFile(path, dir, { logger });
    expect(loaded.mimeType).toBe("image/png");
    expect(loaded.mimeTypeSource).toBe("bytes");
  });

  it("logs the contradiction so the operator does not have to guess", async () => {
    const path = await write("photo.jpg", imageBytes(PNG));
    await loadImageFile(path, dir, { logger });
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("warn");
    expect(records[0]!.message).toMatch(/extension contradicts/i);
    expect(records[0]!.context).toMatchObject({
      path,
      extension: ".jpg",
      fromExtension: "image/jpeg",
      fromBytes: "image/png",
    });
  });

  it("loads without a logger", async () => {
    const path = await write("photo.jpg", imageBytes(PNG));
    const loaded = await loadImageFile(path, dir);
    expect(loaded.mimeType).toBe("image/png");
  });

  it("does not warn when .jpg and .jpeg both mean image/jpeg", async () => {
    const path = await write("shot.jpeg", imageBytes(JPEG));
    const loaded = await loadImageFile(path, dir, { logger });
    expect(loaded.mimeType).toBe("image/jpeg");
    expect(records).toHaveLength(0);
  });

  it("accepts a supported image with no extension at all", async () => {
    const path = await write("clipboard-dump", imageBytes(WEBP));
    const loaded = await loadImageFile(path, dir, { logger });
    expect(loaded.mimeType).toBe("image/webp");
    expect(loaded.mimeTypeSource).toBe("bytes");
    // Nothing to contradict — there is no extension to disagree with.
    expect(records).toHaveLength(0);
  });

  // Precedence rule, second half: unrecognised bytes are "no opinion",
  // not "not an image". Falling back keeps every file that describes
  // fine today describing fine — the defect being fixed is a
  // confidently wrong label, not a missing one.
  it("falls back to the extension when the bytes match nothing", async () => {
    const path = await write("odd.png", Buffer.from(ascii("%PDF-1.7 sort of")));
    const loaded = await loadImageFile(path, dir, { logger });
    expect(loaded.mimeType).toBe("image/png");
    expect(loaded.mimeTypeSource).toBe("extension");
    expect(records).toHaveLength(0);
  });

  it("falls back to the extension for a file too short to sniff", async () => {
    // The first four bytes of the PNG signature: right, and not enough.
    const path = await write("tiny.png", Buffer.from(PNG.slice(0, 4)));
    const loaded = await loadImageFile(path, dir, { logger });
    expect(loaded.mimeType).toBe("image/png");
    expect(loaded.mimeTypeSource).toBe("extension");
  });

  it("falls back to the extension for an empty file", async () => {
    const path = await write("empty.gif", Buffer.alloc(0));
    const loaded = await loadImageFile(path, dir, { logger });
    expect(loaded.mimeType).toBe("image/gif");
    expect(loaded.mimeTypeSource).toBe("extension");
    expect(loaded.bytes.byteLength).toBe(0);
  });

  it("rejects a file whose bytes and extension are both unusable", async () => {
    const path = await write("note.txt", Buffer.from(ascii("not an image")));
    await expect(loadImageFile(path, dir, { logger })).rejects.toBeInstanceOf(
      UnsupportedImageFormatError,
    );
  });

  it("rejects an unsniffable file with no extension", async () => {
    const path = await write("README", Buffer.from(ascii("not an image")));
    await expect(loadImageFile(path, dir, { logger })).rejects.toThrow(
      /\(none\)/,
    );
  });

  // The old message blamed the extension and nothing else, which is now
  // actively misleading: an extension-less PNG is accepted, so a
  // rejection means both signals failed.
  it("names both failed signals in the rejection message", async () => {
    const path = await write("note.txt", Buffer.from(ascii("not an image")));
    const error = await loadImageFile(path, dir).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UnsupportedImageFormatError);
    const message = (error as Error).message;
    expect(message).toMatch(/bytes match no supported image format/i);
    expect(message).toContain('".txt"');
    expect(message).toContain("image/png");
    expect(message).toContain(".webp");
    expect(message).toContain(path);
  });

  it("returns the exact bytes on disk", async () => {
    const bytes = imageBytes(GIF);
    const path = await write("anim.gif", bytes);
    const loaded = await loadImageFile(path, dir);
    expect(Buffer.from(loaded.bytes)).toEqual(bytes);
  });

  it("resolves a path relative to the working directory", async () => {
    await write("rel.png", imageBytes(PNG));
    const loaded = await loadImageFile("rel.png", dir);
    expect(loaded.path).toBe(join(dir, "rel.png"));
    expect(loaded.mimeType).toBe("image/png");
  });
});
