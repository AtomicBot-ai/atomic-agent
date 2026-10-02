// Unit tests for main/reply-paths.ts, against the built output.
// Run: npm run build && npm run test:unit
// Chat review Д23: a path a reply names is offered only when it is a file or a
// folder inside the home folder, and opening one never runs anything.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openTarget, replyPathVerdict, runsWhenOpened } = require("../out/main/reply-paths.js");

const home = mkdtempSync(join(tmpdir(), "reply-home-"));
const outside = mkdtempSync(join(tmpdir(), "reply-outside-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
mkdirSync(join(home, "Desktop"));
writeFileSync(join(home, "Desktop", "trump_news_30_sep_2026.docx"), "x");
mkdirSync(join(home, "My Files"));
writeFileSync(join(home, "My Files", "report final.pdf"), "x");
mkdirSync(join(home, "Tool.app"));
writeFileSync(join(home, "run.command"), "#!/bin/sh\n");
writeFileSync(join(home, "tool"), "#!/bin/sh\n");
chmodSync(join(home, "tool"), 0o755);
writeFileSync(join(home, "notes.txt"), "x");
chmodSync(join(home, "notes.txt"), 0o755);
writeFileSync(join(outside, "secret.txt"), "x");
symlinkSync(join(outside, "secret.txt"), join(home, "escape.txt"));
// A link named like a document that leads to a script, a folder-style installer, and a Finder alias.
symlinkSync(join(home, "run.command"), join(home, "notes-link.txt"));
mkdirSync(join(home, "Installer.pkg"));
writeFileSync(join(home, "Report alias"), Buffer.concat([Buffer.from("book\0\0\0\0mark\0\0\0\0", "latin1"), Buffer.alloc(48)]));

const v = (p) => replyPathVerdict(p, home, "darwin");
const real = (...parts) => realpathSync(join(home, ...parts));

test("a file in the home folder is offered, written with ~ or in full", async () => {
  for (const p of ["~/Desktop/trump_news_30_sep_2026.docx", join(home, "Desktop", "trump_news_30_sep_2026.docx")]) {
    const r = await v(p);
    assert.equal(r.ok, true, p);
    assert.equal(r.kind, "file", p);
    assert.equal(r.reveal, false, p);
    assert.equal(r.abs, real("Desktop", "trump_news_30_sep_2026.docx"), p);
  }
  const spaced = await v("~/My Files/report final.pdf");
  assert.equal(spaced.ok, true);
  const dir = await v("~/Desktop");
  assert.deepEqual([dir.ok, dir.kind, dir.reveal], [true, "dir", false]);
});

test("a path that is not there, or not in the home folder, is not offered", async () => {
  assert.equal((await v("~/Desktop/missing.docx")).why, "missing");
  assert.equal((await v(join(outside, "secret.txt"))).why, "outside-home");
  // A link inside the home folder that leads out of it, and `..` out of it.
  assert.equal((await v("~/escape.txt")).why, "outside-home");
  assert.equal((await v(`~/../${basename(outside)}/secret.txt`)).why, "outside-home");
  assert.equal((await v("/etc/hosts")).why, "outside-home");
});

test("a URL or a relative path is never a file to open", async () => {
  for (const p of ["https://example.com/a.docx", "file:///etc/hosts", "Desktop/x.docx", "", "~/a\nb.txt"]) {
    const r = await v(p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.equal(r.why, "not-a-path", JSON.stringify(p));
  }
  assert.equal((await v(42)).ok, false);
});

test("what would run is shown, not opened", async () => {
  for (const p of ["~/Tool.app", "~/run.command", "~/tool", "~/Installer.pkg", "~/Report alias"]) {
    const r = await v(p);
    assert.equal(r.ok, true, p);
    assert.equal(r.reveal, true, p);
  }
  // A link is judged by what it leads to, and that is what opens.
  const link = await v("~/notes-link.txt");
  assert.deepEqual([link.ok, link.reveal, link.abs], [true, true, real("run.command")]);
  const target = await openTarget(join(home, "notes-link.txt"), "darwin");
  assert.deepEqual(target, { real: real("run.command"), kind: "file", reveal: true });
  assert.equal(await openTarget(join(home, "missing.txt"), "darwin"), null);
  assert.equal(runsWhenOpened("win32", "C:\\Users\\x\\update.msu", "file", 0), true);
  // An execute bit on a document with an extension does not make it a program.
  assert.equal((await v("~/notes.txt")).reveal, false);
  assert.equal(runsWhenOpened("win32", "C:\\Users\\x\\setup.exe", "file", 0), true);
  assert.equal(runsWhenOpened("darwin", "/Users/x/a.pdf", "file", 0o755), false);
  assert.equal(runsWhenOpened("darwin", "/Users/x/Link.webloc", "file", 0o644), true);
});
