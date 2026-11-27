// ATO-2391: the desktop pet's pages and wiring. The bubble (renderer/pet.js),
// the main window's relay that answers with its own card
// (renderer/pet-relay.js), and the View menu's switch (main/menu.ts, built).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../renderer/pet.js");
const R = require("../renderer/pet-relay.js");
const { menuTemplate } = require("../out/main/menu.js");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const req = (over = {}) => ({ approvalId: "ap-1", tool: "shell.exec", text: "run ls", risk: "", question: false, canAllow: true, ...over });

test("the bubble: Allow once and Deny for an ordinary request", () => {
  const m = P.petBubbleModel({ state: "waiting", approval: req(), more: 2 }, new Set());
  assert.equal(m.title, "Allow shell.exec?");
  assert.equal(m.allow, true);
  assert.equal(m.deny, true);
  assert.equal(m.more, "2 more waiting");
});

test("the bubble: a request kept for the full card offers Review and Deny, never Allow", () => {
  const m = P.petBubbleModel({ state: "waiting", approval: req({ canAllow: false, risk: "Risk check: high." }), more: 0 }, new Set());
  assert.equal(m.allow, false);
  assert.equal(m.deny, true);
  assert.equal(m.openLabel, "Review");
  assert.match(m.text, /Review this one in Atomic Agent/);
  assert.equal(m.risk, "Risk check: high.");
});

test("the bubble: a question is answered in the window only", () => {
  const m = P.petBubbleModel({ state: "waiting", approval: req({ question: true, canAllow: false }), more: 0 }, new Set());
  assert.equal(m.allow, false);
  assert.equal(m.deny, false);
  assert.equal(m.openLabel, "Answer in Atomic Agent");
});

test("no bubble without a request, or for one put away", () => {
  assert.equal(P.petBubbleModel({ state: "idle", approval: null, more: 0 }, new Set()), null);
  assert.equal(P.petBubbleModel({ state: "waiting", approval: req(), more: 0 }, new Set(["ap-1"])), null);
});

test("the sprite's class and badge per state", () => {
  assert.equal(P.petBodyClass({ state: "working", dnd: false }), "pet st-working");
  assert.equal(P.petBodyClass({ state: "nonsense" }), "pet st-idle");
  assert.equal(P.petBodyClass({ state: "waiting", dnd: true }), "pet st-waiting dnd");
  assert.equal(P.petBadge({ state: "waiting" }), "!");
  assert.equal(P.petBadge({ state: "idle" }), "");
  assert.equal(P.petBadge({ state: "waiting", dnd: true }), "☾");
  const css = read("../renderer/css/pet.css");
  for (const s of P.PET_STATE_NAMES.filter((s) => s !== "idle")) assert.match(css, new RegExp(`\\.st-${s} `), `pet.css draws ${s}`);
});

test("the relay picks the window's own open card, never a question or one being answered", () => {
  const open = { k: "approval", approvalId: "ap-1" };
  const kept = new Map([["s2", { k: "approval", approvalId: "ap-2" }]]);
  const live = new Map([["t", { log: [{ k: "approval", approvalId: "ap-3" }] }]]);
  const cards = R.petRelayCards([open, { k: "system" }, { k: "approval", approvalId: "old", stored: true }], kept, live);
  assert.deepEqual(cards.map((c) => c.approvalId), ["ap-1", "ap-3", "ap-2"]);
  const isOpen = (m) => !m.state;
  assert.equal(R.petRelayPick(cards, "ap-2", isOpen), kept.get("s2"));
  assert.equal(R.petRelayPick(cards, "nope", isOpen), null);
  assert.equal(R.petRelayPick([{ k: "approval", approvalId: "q", question: {} }], "q", isOpen), null);
  assert.equal(R.petRelayPick([{ k: "approval", approvalId: "a", answering: true }], "a", isOpen), null);
  assert.equal(R.petRelayPick([{ k: "approval", approvalId: "c", state: "approved" }], "c", isOpen), null);
});

test("the relay answers with the card's Allow once (y) or Deny (n) only", () => {
  assert.equal(R.petRelayKey("allow"), "y");
  assert.equal(R.petRelayKey("deny"), "n");
  assert.equal(R.petRelayKey("allow-always"), null);
  assert.equal(R.petRelayKey("w"), null);
  const src = read("../renderer/pet-relay.js");
  assert.match(src, /answerLive\(req, key\)/, "the card's own answer path");
  assert.doesNotMatch(src, /BR\.approve\(/, "never a second route to the agent");
});

test("the main window loads the relay; the pet page has its own strict CSP", () => {
  assert.match(read("../renderer/index.html"), /<script src="pet-relay\.js"><\/script>/);
  const html = read("../renderer/pet.html");
  assert.match(html, /default-src 'none'; script-src 'self'/);
  assert.match(html, /<script src="pet\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>/, "no inline script");
});

test("agent:approve and the pet share one function, and the window's answers clear the bubble", () => {
  const main = read("../main/main.ts");
  assert.match(main, /ipcMain\.handle\("agent:approve", \(_event, payload: unknown\) => approveFromUi\(payload\)\);/);
  assert.match(main, /approve: \(approvalId, decision\) => approveFromUi\(\{ approvalId, decision \}\)/);
  assert.match(main, /petHub\?\.approvalAnswered\(approvalId\);/);
  const preload = read("../preload/preload.ts");
  assert.match(preload, /answer: \(approvalId: string, decision: "allow" \| "deny"\) => ipcRenderer\.invoke\("pet:answer"/);
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`View › Desktop Pet: Show Pet and Do Not Disturb, off by default (${platform})`, () => {
    const sent = [];
    const view = menuTemplate((c) => sent.push(c), platform).find((m) => m.label === "View");
    const pet = view.submenu.find((i) => i.label === "Desktop Pet");
    assert.ok(pet, "View has Desktop Pet");
    const show = pet.submenu.find((i) => i.label === "Show Pet");
    const dnd = pet.submenu.find((i) => i.label === "Do Not Disturb");
    assert.equal(show.type, "checkbox");
    assert.equal(show.checked, false, "off by default");
    assert.equal(dnd.checked, false);
    show.click();
    dnd.click();
    assert.deepEqual(sent, ["pet:toggle", "pet:dnd"]);
    const on = menuTemplate(() => {}, platform, { keepRunning: false, startAtLogin: false, pet: { enabled: true, dnd: true } })
      .find((m) => m.label === "View").submenu.find((i) => i.label === "Desktop Pet").submenu;
    assert.equal(on[0].checked, true);
    assert.equal(on[1].checked, true);
  });
}
