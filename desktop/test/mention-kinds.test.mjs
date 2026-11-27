// Unit tests for main/mention-kinds.ts and main/mention-url.ts (ATO-2241), against the built output.
// Run: npm run build && npm run test:unit
// Which `@` words are diff / git / ranges / links, what the palette offers for them,
// and the bounded, http(s)-only page read behind `@https://...`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const K = require("../out/main/mention-kinds.js");
const U = require("../out/main/mention-url.js");

// ---------------------------------------------------------------- kinds

test("diff, git:N, ranges and links are told apart; everything else is not a kind", () => {
  assert.deepEqual(K.parseMentionKind("diff"), { kind: "diff" });
  assert.deepEqual(K.parseMentionKind("git:4"), { kind: "git", count: 4 });
  assert.deepEqual(K.parseMentionKind("git:99"), { kind: "git", count: 20 });
  assert.equal(K.parseMentionKind("git:0"), null);
  assert.deepEqual(K.parseMentionKind("src/a.ts:10-40"), { kind: "range", path: "src/a.ts", start: 10, end: 40 });
  assert.deepEqual(K.parseMentionKind("src/a.ts:7"), { kind: "range", path: "src/a.ts", start: 7, end: 7 });
  assert.deepEqual(K.parseMentionKind("a.ts#L10-L40"), { kind: "range", path: "a.ts", start: 10, end: 40 });
  assert.deepEqual(K.parseMentionKind("a.ts#L10-40"), { kind: "range", path: "a.ts", start: 10, end: 40 });
  assert.equal(K.parseMentionKind("a.ts:40-10"), null);
  assert.equal(K.parseMentionKind("a.ts:0"), null);
  assert.deepEqual(K.parseMentionKind("https://example.com/a?b=1"), { kind: "url", url: "https://example.com/a?b=1" });
  assert.deepEqual(K.parseMentionKind("http://localhost:3000"), { kind: "url", url: "http://localhost:3000/" });
  assert.equal(K.parseMentionKind("https://user:pw@host/"), null);
  for (const word of ["ftp://host/x", "file:///etc/hosts", "javascript:alert(1)", "src/a.ts", "Diff", "git", "git:x"]) {
    assert.equal(K.parseMentionKind(word), null, word);
  }
});

test("the palette offers diff and git:5 for a prefix, and keeps a typed range, link or folder as typed", () => {
  assert.deepEqual(K.contextSuggestions(""), []);
  assert.deepEqual(K.contextSuggestions("d"), ["diff"]);
  assert.deepEqual(K.contextSuggestions("gi"), ["git:5"]);
  assert.deepEqual(K.contextSuggestions("git:3"), ["git:3"]);
  assert.deepEqual(K.contextSuggestions("git:77"), ["git:20"]);
  assert.deepEqual(K.contextSuggestions("src/a.ts:10-40"), ["src/a.ts:10-40"]);
  assert.deepEqual(K.contextSuggestions("https://example.com/x"), ["https://example.com/x"]);
  assert.deepEqual(K.contextSuggestions("src/"), ["src/"]);
  assert.deepEqual(K.contextSuggestions("readme"), []);
});

// ---------------------------------------------------------------- links

const page = (body, type = "text/html; charset=utf-8", status = 200) =>
  async () => new Response(body, { status, headers: { "content-type": type } });

test("an HTML page comes back as its words, without scripts and styles", async () => {
  const fetchUrl = U.createFetchUrl(page("<html><head><title>T</title><style>x{}</style></head><body><h1>Hello &amp; welcome</h1><script>evil()</script><p>Second&nbsp;line</p></body></html>"));
  const got = await fetchUrl("https://example.com/");
  assert.equal(got.text, "Hello & welcome\nSecond line");
  assert.equal(got.cut, false);
});

test("a page past the byte cap is cut and the read stops there", async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode("a".repeat(1000))); },
  });
  const fetchUrl = U.createFetchUrl(async () => new Response(endless, { headers: { "content-type": "text/plain" } }), 5_000, 2_500);
  const got = await fetchUrl("https://example.com/big");
  assert.equal(got.text.length, 2_500);
  assert.equal(got.cut, true);
  assert.ok(pulled < 10);
});

test("a page that does not answer in time is named, not waited on", async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const fetchUrl = U.createFetchUrl(hang, 30);
  await assert.rejects(fetchUrl("https://slow.example/"), (err) => err instanceof U.UrlSkip && /no answer/.test(err.message));
});

test("an error status, a binary answer and a non-http link are refused with a reason", async () => {
  await assert.rejects(U.createFetchUrl(page("nope", "text/plain", 404))("https://x.example/"),
    (err) => err instanceof U.UrlSkip && err.message === "HTTP 404");
  await assert.rejects(U.createFetchUrl(page("PNG", "image/png"))("https://x.example/a.png"),
    (err) => err instanceof U.UrlSkip && /not a text page \(image\/png\)/.test(err.message));
  let called = false;
  await assert.rejects(U.createFetchUrl(async () => { called = true; return new Response("x"); })("file:///etc/hosts"),
    (err) => err instanceof U.UrlSkip);
  assert.equal(called, false);
});

// ---------------------------------------------------------------- linear HTML

const H = require("../out/main/mention-html.js");
const HALF_MB = 512 * 1024;

test("512 KB of hostile markup is reduced in linear time, not frozen on", () => {
  for (const [name, body] of [
    ["unclosed comments", "<!--".repeat(HALF_MB / 4)],
    ["unclosed scripts", "<script".repeat(Math.floor(HALF_MB / 7))],
    ["scripts with no end tag", "<script>".repeat(HALF_MB / 8)],
    ["bare angle brackets", "<".repeat(HALF_MB)],
    ["tags with no end", "<a".repeat(HALF_MB / 2)],
  ]) {
    const started = performance.now();
    H.htmlToText(body);
    const took = performance.now() - started;
    assert.ok(took < 500, `${name}: ${Math.round(took)} ms`);
  }
});

test("the scan keeps text, a bare < and line ends; an unclosed comment drops the rest", () => {
  assert.equal(H.htmlToText("<p>a < b</p><p>c</p>"), "a < b\nc");
  assert.equal(H.htmlToText("<!DOCTYPE html><div>one<br>two</div>"), "one\ntwo");
  assert.equal(H.htmlToText("kept <!-- never closed <p>gone</p>"), "kept");
  assert.equal(H.htmlToText("<SCRIPT>x()</Script >after"), "after");
});

// ---------------------------------------------------------------- local addresses

const N = require("../out/main/mention-hosts.js");

test("loopback, private and link-local hosts are local; public ones are not", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1",
    "169.254.169.254", "100.100.1.1", "0.0.0.0", "[::1]", "[fe80::1]", "[fd12::1]", "[::ffff:7f00:1]", "printer.local"]) {
    assert.equal(N.isLocalHost(host), true, host);
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]", "localhost.example.com"]) {
    assert.equal(N.isLocalHost(host), false, host);
  }
});

/** A fetch answer as fetch gives it after redirects (`url` is the final address). */
const landed = (finalUrl, body = "inside") => async () => ({
  ok: true, status: 200, url: finalUrl,
  headers: new Headers({ "content-type": "text/plain" }),
  body: new Response(body).body,
});

test("a public link that redirects to a local address is refused", async () => {
  for (const target of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/"]) {
    await assert.rejects(U.createFetchUrl(landed(target))("https://public.example/go"),
      (err) => err instanceof U.UrlSkip && err.message === "redirected to a local address", target);
  }
});

test("a local link typed on purpose is still read, and a public landing is fine", async () => {
  assert.equal((await U.createFetchUrl(landed("http://localhost:3000/"))("http://localhost:3000")).text, "inside");
  assert.equal((await U.createFetchUrl(landed("http://127.0.0.1:8080/b"))("http://localhost:8080/a")).text, "inside");
  assert.equal((await U.createFetchUrl(landed("https://www.example.com/"))("https://example.com/")).text, "inside");
});
