// ATO-668: the right-click menu on text (main/edit-context-menu.ts).
// Against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { editContextMenuTemplate, spellcheckEnabled, MAX_SUGGESTIONS } = require("../out/main/edit-context-menu.js");

const flags = (on = true) => ({ canCut: on, canCopy: on, canPaste: on, canSelectAll: on, canUndo: on, canRedo: on, canDelete: on, canEditRichly: false });
const params = (over) => ({ isEditable: false, selectionText: "", misspelledWord: "", dictionarySuggestions: [], editFlags: flags(), ...over });
const noop = { replaceMisspelling: () => {}, addToDictionary: () => {} };
const roles = (t) => t.filter((i) => i.role).map((i) => i.role);

test("a text field gets Cut, Copy, Paste and Select All, enabled as Chromium says", () => {
  const t = editContextMenuTemplate(params({ isEditable: true, editFlags: { ...flags(), canCut: false, canCopy: false } }), noop);
  assert.deepEqual(roles(t), ["cut", "copy", "paste", "selectAll"]);
  assert.equal(t.find((i) => i.role === "cut").enabled, false);
  assert.equal(t.find((i) => i.role === "paste").enabled, true);
});

test("selected text in a reply gets Copy only", () => {
  assert.deepEqual(roles(editContextMenuTemplate(params({ selectionText: "hello" }), noop)), ["copy"]);
});

test("nothing selected outside a field opens no menu", () => {
  assert.deepEqual(editContextMenuTemplate(params({ selectionText: "   " }), noop), []);
});

test("a misspelled word lists suggestions that replace it, and Add to Dictionary", () => {
  const calls = [];
  const actions = { replaceMisspelling: (w) => calls.push(["replace", w]), addToDictionary: (w) => calls.push(["add", w]) };
  const sugg = ["one", "two", "three", "four", "five", "six", "seven"];
  const t = editContextMenuTemplate(params({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: sugg }), actions);
  const labels = t.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels.slice(0, MAX_SUGGESTIONS), sugg.slice(0, MAX_SUGGESTIONS));
  assert.ok(!labels.includes("six"), "at most MAX_SUGGESTIONS suggestions");
  t.find((i) => i.label === "two").click();
  t.find((i) => i.label === "Add to Dictionary").click();
  assert.deepEqual(calls, [["replace", "two"], ["add", "teh"]]);
  assert.deepEqual(roles(t), ["cut", "copy", "paste", "selectAll"], "the edit items follow");
});

test("a misspelled word with no suggestions says so, disabled", () => {
  const t = editContextMenuTemplate(params({ isEditable: true, misspelledWord: "zxqv" }), noop);
  assert.equal(t[0].label, "No Guesses Found");
  assert.equal(t[0].enabled, false);
});

test("spellcheck is off on Linux only (no Hunspell download)", () => {
  assert.equal(spellcheckEnabled("darwin"), true);
  assert.equal(spellcheckEnabled("win32"), true);
  assert.equal(spellcheckEnabled("linux"), false);
});

test("main.ts wires the menu into the window and drops the blanket spellcheck: false", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(src, /wireEditContextMenu\(window\.webContents\)/);
  assert.match(src, /spellcheck: spellcheckEnabled\(process\.platform\)/);
  assert.doesNotMatch(src, /spellcheck: false/);
});
