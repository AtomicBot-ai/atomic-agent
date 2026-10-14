// Unit tests for main/image-data-url.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-408: an image the agent attached (or the person did) is read by main and
// handed to the window as a data: URL, only from inside the allowed roots,
// only when its first bytes say PNG/JPEG/WebP/GIF, and only under the size cap.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { imageDataUrl, imageRootsFor, openImage, readOpenedImage, sniffImageMime } = require("../out/main/image-data-url.js");

const home = mkdtempSync(join(tmpdir(), "image-home-"));
const state = mkdtempSync(join(tmpdir(), "image-state-"));
const outside = mkdtempSync(join(tmpdir(), "image-outside-"));
after(() => {
  for (const d of [home, state, outside]) rmSync(d, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const GIF = Buffer.from("GIF89a\x01\x00", "latin1");

mkdirSync(join(home, "Pictures"));
writeFileSync(join(home, "Pictures", "chart.png"), PNG);
writeFileSync(join(home, "photo.jpg"), JPEG);
writeFileSync(join(home, "wrong-name.txt"), WEBP);
writeFileSync(join(home, "fake.png"), "<svg onload=alert(1)>");
writeFileSync(join(home, "big.gif"), Buffer.concat([GIF, Buffer.alloc(64)]));
writeFileSync(join(state, "generated.png"), PNG);
writeFileSync(join(outside, "secret.png"), PNG);
symlinkSync(join(outside, "secret.png"), join(home, "escape.png"));

const roots = [home, state];
const read = (p, max) => imageDataUrl(p, roots, home, "darwin", max);

test("sniffs the four image types by their first bytes, nothing else", () => {
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  assert.equal(sniffImageMime(WEBP), "image/webp");
  assert.equal(sniffImageMime(GIF), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("<svg")), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test("an image in the home folder comes back as a data URL of its real type", async () => {
  const r = await read(join(home, "Pictures", "chart.png"));
  assert.equal(r.ok, true);
  assert.equal(r.dataUrl, `data:image/png;base64,${PNG.toString("base64")}`);
  const tilde = await imageDataUrl("~/photo.jpg", roots, home, "darwin");
  assert.equal(tilde.ok, true);
  assert.match(tilde.dataUrl, /^data:image\/jpeg;base64,/);
});

test("the type follows the bytes, not the name", async () => {
  const r = await read(join(home, "wrong-name.txt"));
  assert.equal(r.ok, true);
  assert.match(r.dataUrl, /^data:image\/webp;base64,/);
  assert.deepEqual(await read(join(home, "fake.png")), { ok: false, reason: "missing" });
});

test("an image in the agent's state folder is allowed", async () => {
  const r = await read(join(state, "generated.png"));
  assert.equal(r.ok, true);
});

test("outside the roots, through a link, or as a URL is refused as outside", async () => {
  assert.deepEqual(await read(join(outside, "secret.png")), { ok: false, reason: "outside" });
  assert.deepEqual(await read(join(home, "escape.png")), { ok: false, reason: "outside" });
  assert.deepEqual(await read(join(home, "..", "x.png")), { ok: false, reason: "outside" });
  assert.deepEqual(await read("file:///etc/passwd"), { ok: false, reason: "outside" });
  assert.deepEqual(await read("https://example.com/a.png"), { ok: false, reason: "outside" });
});

test("missing, a folder, a relative path or junk is missing", async () => {
  assert.deepEqual(await read(join(home, "gone.png")), { ok: false, reason: "missing" });
  assert.deepEqual(await read(join(home, "Pictures")), { ok: false, reason: "missing" });
  assert.deepEqual(await read("chart.png"), { ok: false, reason: "missing" });
  assert.deepEqual(await read(42), { ok: false, reason: "missing" });
  assert.deepEqual(await read("a\0b"), { ok: false, reason: "missing" });
});

test("over the cap is too-large and is not read", async () => {
  assert.deepEqual(await read(join(home, "big.gif"), 16), { ok: false, reason: "too-large" });
  const r = await read(join(home, "big.gif"), 1024);
  assert.equal(r.ok, true);
});

test("the data URL says which version of the file it is", async () => {
  const r = await read(join(home, "Pictures", "chart.png"));
  assert.equal(r.mime, "image/png");
  assert.equal(r.size, PNG.length);
  assert.equal(typeof r.mtimeMs, "number");
  assert.ok(r.mtimeMs > 0);
});

test("openImage is what Save As and Reveal use: pictures only, the checked file, under the cap", async () => {
  const opened = await openImage(join(home, "Pictures", "chart.png"), roots, home, "darwin");
  assert.equal(opened.ok, true);
  try {
    assert.match(opened.image.real, /chart\.png$/);
    assert.equal(opened.image.mime, "image/png");
    const bytes = await readOpenedImage(opened.image);
    assert.deepEqual(Buffer.from(bytes), PNG);
  } finally {
    await opened.image.fh.close();
  }
  // A private key named like anything is not a picture, so it cannot be saved or revealed from the viewer.
  writeFileSync(join(home, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.deepEqual(await openImage(join(home, "id_rsa"), roots, home, "darwin"), { ok: false, reason: "missing" });
  assert.deepEqual(await openImage(join(outside, "secret.png"), roots, home, "darwin"), { ok: false, reason: "outside" });
  assert.deepEqual(await openImage(join(home, "big.gif"), roots, home, "darwin", 16), { ok: false, reason: "too-large" });
});

test("the roots are home, the agent's folder and the temporary folders", () => {
  assert.deepEqual(imageRootsFor("darwin", "/Users/a", "/Users/a/.atomic-agent-desktop", "/var/folders/x/T"),
    ["/Users/a", "/Users/a/.atomic-agent-desktop", "/var/folders/x/T", "/tmp", "/var/tmp"]);
  assert.deepEqual(imageRootsFor("win32", "C:\\Users\\a", "C:\\Users\\a\\.atomic-agent-desktop", "C:\\Users\\a\\AppData\\Local\\Temp"),
    ["C:\\Users\\a", "C:\\Users\\a\\.atomic-agent-desktop", "C:\\Users\\a\\AppData\\Local\\Temp"]);
});

test("a picture in a temporary root is shown", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "image-tmp-root-"));
  try {
    writeFileSync(join(tmpRoot, "plot.png"), PNG);
    const r = await imageDataUrl(join(tmpRoot, "plot.png"), [home, tmpRoot], home, "darwin");
    assert.equal(r.ok, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
