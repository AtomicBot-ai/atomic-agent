// ATO-2746: a failure toast must never wear the green tick. toast(t, s, kind)
// in renderer/renderer.js draws the check unless kind is 'bad' (or 'info'),
// so every call whose title says it failed ("Could not…", "Couldn't…",
// "Failed…", "Not while a turn is running", "…did not start") has to pass a
// kind. This parses every renderer/*.js file (TypeScript's parser, comments
// and strings understood) and lists each such call that passes none.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const DIR = new URL("../renderer/", import.meta.url);
const FAILURE = /\b(could not|couldn['’]t|can['’]t|cannot|failed|unable to|not while|did not|didn['’]t|not sent|not saved|wasn['’]t|no longer waits)\b/i;

/*
 * ATO-2747 (the Trash PR) gives the Trash's own failure toasts their kind, with
 * the rest of that work; until it lands they are listed here. Once it has
 * landed this list can be emptied (an entry that matches nothing is harmless).
 */
const ELSEWHERE = new Set([
  "chat-trash.js|Could not restore the chat",
  "chat-trash.js|Could not delete the chat",
  "chat-trash.js|Could not empty Trash",
  "renderer.js|Could not move the chat to Trash",
]);

/** Every string literal's text inside `node`. */
function literals(node, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
  else if (ts.isTemplateExpression(node)) out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
  ts.forEachChild(node, (n) => { literals(n, out); });
  return out;
}

/** A kind argument that leaves the green tick: missing, '', undefined or null. */
function noKind(arg) {
  if (!arg) return true;
  if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && !arg.text) return true;
  return arg.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(arg) && arg.text === "undefined");
}

/** The failure-titled toast(...) calls in `file` that pass no kind: [{file, line, title}]. */
function unkinded(file) {
  const text = readFileSync(new URL(file, DIR), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "toast" && node.arguments.length) {
      const titles = literals(node.arguments[0]).filter((t) => FAILURE.test(t));
      if (titles.length && noKind(node.arguments[2])) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        for (const title of titles) out.push({ file, line, title });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const FILES = readdirSync(DIR).filter((f) => f.endsWith(".js"));

test("every failure toast in desktop/renderer passes a kind (no green tick)", () => {
  assert.ok(FILES.includes("renderer.js") && FILES.length > 20, "the renderer sources were found");
  const all = FILES.flatMap(unkinded);
  const left = all.filter((c) => !ELSEWHERE.has(c.file + "|" + c.title));
  assert.deepEqual(left.map((c) => `${c.file}:${c.line} ${c.title}`), []);
});

test("the scan sees what it must: a bare failure toast is caught, a kinded one and a comment are not", () => {
  const src = [
    "toast('Could not open', r.error || '');",
    "toast(on ? 'Could not archive' : 'Could not unarchive', '', 'bad');",
    "toast(\"Couldn't continue\",\n  'why', 'bad');",
    "/* toast('Could not in a comment') */",
    "toast('Not while a turn is running', '', '');",
    "toast('Saved', 'ok');",
  ].join("\n");
  const sf = ts.createSourceFile("x.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "toast") {
      if (literals(n.arguments[0]).some((t) => FAILURE.test(t)) && noKind(n.arguments[2])) hits.push(literals(n.arguments[0])[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.deepEqual(hits, ["Could not open", "Not while a turn is running"]);
});

test("the failure toasts built from a note pass 'bad' too (chat popout, video Save/Show)", () => {
  const pop = readFileSync(new URL("chat-popout.js", DIR), "utf8");
  assert.match(pop, /const say = \(t\) => \{ if \(t && typeof toast === 'function'\) toast\(t\.title, t\.sub, 'bad'\); \};/);
  const media = readFileSync(new URL("chat-media.js", DIR), "utf8");
  assert.match(media, /toast\(note\.title, note\.sub, note\.kind\)/);
  const c = {};
  vm.createContext(c);
  vm.runInContext(media.slice(media.indexOf("function chatVideoActionNote"), media.indexOf("/** Runs one action")), c);
  const note = vm.runInContext("chatVideoActionNote", c);
  assert.equal(note("save", { ok: false, reason: "missing" }).kind, "bad");
  assert.equal(note("reveal", null).kind, "bad");
  assert.equal(note("save", { ok: true, path: "/x" }).kind, undefined, "a success keeps the green tick");
});
