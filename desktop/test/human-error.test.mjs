// ATO-2744: renderer/human-error.js, the one sentence + Details helper the
// panels share. Pure: loaded as a CommonJS module, no build needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../renderer/human-error.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("raw words: an Error's message, a string, nothing", () => {
  assert.equal(H.herrRaw(new Error("  EPERM: operation not permitted  ")), "EPERM: operation not permitted");
  assert.equal(H.herrRaw("x"), "x");
  assert.equal(H.herrRaw(null), "");
  assert.equal(H.herrCode("EACCES: permission denied, open '/a/b'"), "EACCES");
  assert.equal(H.herrCode("Error: something"), "", "a word starting with E is not an errno");
  assert.equal(H.herrBase("C:\\Users\\me\\report.pdf"), "report.pdf");
  assert.equal(H.herrBase("/Users/me/report.pdf"), "report.pdf");
});

test("a file that could not be read: permission in words, the macOS privacy hint only on macOS", () => {
  const mac = H.herrFsRead("EPERM: operation not permitted, open '/Users/me/Documents/a.pdf'", "a.pdf", "darwin");
  assert.equal(mac.text, "Atomic Agent isn't allowed to read a.pdf.");
  assert.match(mac.hint, /Privacy & Security › Files and Folders/);
  assert.match(mac.hint, /Full Disk Access/);
  assert.match(mac.detail, /^EPERM/);
  for (const platform of ["win32", "linux"]) {
    const other = H.herrFsRead("EACCES: permission denied, open 'C:\\x\\a.pdf'", "a.pdf", platform);
    assert.equal(other.text, "Atomic Agent isn't allowed to read a.pdf.");
    assert.doesNotMatch(other.hint, /System Settings|Full Disk Access/);
  }
  assert.equal(H.herrFsRead("ENOENT: no such file or directory", "a.pdf", "darwin").text, "Couldn't find a.pdf. It may have been moved or deleted.");
  assert.equal(H.herrFsRead("something odd", "this file", "linux").text, "Couldn't read this file.");
});

test("git worktree refusals: no commits, not a repo, permission, anything else", () => {
  assert.equal(H.herrGitWorktree("fatal: invalid reference: HEAD").text, "This folder has no commits yet. Make a first commit, then try again.");
  assert.equal(H.herrGitWorktree("Worker 1\nfatal: not a valid object name: 'HEAD'").text, "This folder has no commits yet. Make a first commit, then try again.");
  assert.equal(H.herrGitWorktree("fatal: not a git repository (or any of the parent directories): .git").text, "This folder isn't a git repository.");
  assert.equal(H.herrGitWorktree("fatal: could not create leading directories of '/x': Permission denied").text, "Atomic Agent can't write to this folder.");
  const other = H.herrGitWorktree("fatal: '/x' already exists");
  assert.equal(other.text, "Couldn't make a worker copy of this folder.");
  assert.equal(other.detail, "fatal: '/x' already exists");
});

test("a sentence for a person is kept; raw words are not", () => {
  assert.equal(H.herrSentence("This agent version cannot hand a chat to Claude Code or Codex. Update Atomic Agent."),
    "This agent version cannot hand a chat to Claude Code or Codex. Update Atomic Agent.");
  assert.equal(H.herrSentence("Terminal could not be opened. spawn osascript ENOENT"), "Terminal could not be opened.");
  for (const raw of ["session id is not valid", "EPERM: operation not permitted", "fatal: invalid reference: HEAD",
    "Error: boom.", "Could not read /Users/me/x/y.txt.", "line one.\nline two."]) {
    assert.equal(H.herrSentence(raw), "", raw);
  }
});

test("the notice: the sentence, the hint, the raw words folded under Details, all escaped", () => {
  const html = H.herrNoticeHTML({ text: "Couldn't <b>read</b> it.", hint: "Try again.", detail: "EPERM <script>" }, { icon: "<svg></svg>", cls: "x" });
  assert.match(html, /^<div class="tk-notice tk-notice--red herr x" role="alert"><svg><\/svg><span class="grow">/);
  assert.ok(html.includes('<span class="herr-t">Couldn&#39;t &lt;b&gt;read&lt;/b&gt; it.</span><span class="herr-hint">Try again.</span>'));
  assert.ok(html.includes('<details class="herr-det"><summary>Details</summary><pre class="herr-raw">EPERM &lt;script&gt;</pre></details>'));
  assert.ok(!/<details[^>]* open/.test(html), "Details starts folded");
  // Nothing more to say than the sentence: no Details at all.
  assert.ok(!H.herrNoticeHTML({ text: "Same.", detail: "Same." }).includes("<details"));
  assert.ok(!H.herrNoticeHTML("Just a sentence.").includes("<details"));
  assert.equal(H.herrNoticeHTML(null), "");
});

test("hooks: loaded before the panels that call it, and styled", () => {
  const html = read("../renderer/index.html");
  const at = html.indexOf('<script src="human-error.js"></script>');
  assert.ok(at > 0);
  for (const f of ["handoff-out.js", "agent-hub.js", "project-workers.js", "my-files.js", "privacy-shield.js", "show-once.js", "email-tasks.js", "renderer.js"]) {
    assert.ok(at < html.indexOf(`src="${f}"`), f);
  }
  assert.match(read("../renderer/css/overlays.css"), /\.herr-det > summary\{/);
});
