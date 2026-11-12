// ATO-1467: the "Talk to the team" interview invite. The limits (7 days,
// 90 days, 2 times, "Don't ask again", analytics off, DO_NOT_TRACK, a turn,
// setup, an error), the form link, the PostHog flag reply, the shared state
// file, the menu item, the catalogue and the window's card.
// Against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const INV = require("../out/main/interview-invite.js");
const V = require("../out/main/analytics/validate.js");
const { menuTemplate } = require("../out/main/menu.js");
const CARD = require("../renderer/interview-card.js");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 12);
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const empty = () => ({ shownAt: [], neverAt: null });
const ctx = (over = {}) => ({
  now: NOW, analyticsEnabled: true, doNotTrack: false, installId: ID, daysSinceInstall: 30,
  busy: false, onboarding: false, error: false, state: empty(), ...over,
});

test("an eligible install is blocked by nothing but the flag", () => {
  assert.equal(INV.inviteBlockedBy(ctx()), null);
});

test("privacy first: analytics off or DO_NOT_TRACK blocks before anything else", () => {
  assert.equal(INV.inviteBlockedBy(ctx({ analyticsEnabled: false, busy: true })), "analytics_off");
  assert.equal(INV.inviteBlockedBy(ctx({ doNotTrack: true })), "do_not_track");
  assert.equal(INV.inviteBlockedBy(ctx({ installId: null })), "no_install_id");
});

test("Don't ask again is for good", () => {
  assert.equal(INV.inviteBlockedBy(ctx({ state: { shownAt: [], neverAt: NOW - 500 * DAY }, now: NOW + 5000 * DAY })), "never");
});

test("7 days after install, once per 90 days, 2 times in all", () => {
  assert.equal(INV.inviteBlockedBy(ctx({ daysSinceInstall: 6 })), "too_new");
  assert.equal(INV.inviteBlockedBy(ctx({ daysSinceInstall: 7 })), null);
  assert.equal(INV.inviteBlockedBy(ctx({ daysSinceInstall: undefined })), null, "an install with no date is old enough");
  assert.equal(INV.inviteBlockedBy(ctx({ state: { shownAt: [NOW - 89 * DAY], neverAt: null } })), "cooldown");
  assert.equal(INV.inviteBlockedBy(ctx({ state: { shownAt: [NOW - 90 * DAY], neverAt: null } })), null);
  assert.equal(INV.inviteBlockedBy(ctx({ state: { shownAt: [NOW + DAY], neverAt: null } })), "cooldown", "a show in the future still counts");
  assert.equal(INV.inviteBlockedBy(ctx({ state: { shownAt: [NOW - 900 * DAY, NOW - 400 * DAY], neverAt: null } })), "max_shows");

  let state = empty();
  let shows = 0;
  for (let day = 0; day < 1000; day++) {
    const c = ctx({ now: NOW + day * DAY, daysSinceInstall: day, state });
    if (INV.inviteBlockedBy(c) === null) { shows++; state = INV.mergeInviteStates(state, { shownAt: [c.now], neverAt: null }); }
  }
  assert.equal(shows, 2, "a whole life of one install: two shows, never a third");
});

test("never during a turn, first-run setup or an error", () => {
  assert.equal(INV.inviteBlockedBy(ctx({ busy: true })), "busy");
  assert.equal(INV.inviteBlockedBy(ctx({ onboarding: true })), "onboarding");
  assert.equal(INV.inviteBlockedBy(ctx({ error: true })), "error");
});

test("the state file: malformed reads as nothing, a refusal is never lost, two copies merge", () => {
  assert.deepEqual(INV.parseInviteState("x"), empty());
  assert.deepEqual(INV.parseInviteState({ shownAt: [3, "a", 1] }).shownAt, [1, 3]);
  assert.equal(INV.parseInviteState({ neverAt: "yes" }).neverAt, 0);
  assert.deepEqual(INV.mergeInviteStates({ shownAt: [1], neverAt: null }, { shownAt: [1, 2], neverAt: 5 }), { shownAt: [1, 2], neverAt: 5 });
});

test("the shared file: written, merged with what the terminal wrote, read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "invite-"));
  try {
    writeFileSync(join(dir, INV.INTERVIEW_INVITE_FILE), JSON.stringify({ shownAt: [10], neverAt: 20 }));
    assert.deepEqual(INV.writeInviteState(dir, { shownAt: [30], neverAt: null }), { shownAt: [10, 30], neverAt: 20 });
    assert.deepEqual(INV.readInviteState(dir), { shownAt: [10, 30], neverAt: 20 });
    assert.equal(INV.INTERVIEW_INVITE_FILE, "interview-invite.json", "the terminal's file name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the form link: the id only with analytics on and no DO_NOT_TRACK; src=app-desktop", () => {
  const on = new URL(INV.interviewFormUrl({ installId: ID, analyticsEnabled: true, doNotTrack: false }));
  assert.equal(on.origin + on.pathname, "https://tally.so/r/bZjNb6");
  assert.equal(on.searchParams.get("iid"), ID);
  assert.equal(on.searchParams.get("src"), "app-desktop");
  for (const over of [{ analyticsEnabled: false, doNotTrack: false }, { analyticsEnabled: true, doNotTrack: true }]) {
    const off = new URL(INV.interviewFormUrl({ installId: ID, ...over }));
    assert.equal(off.searchParams.has("iid"), false);
  }
  assert.equal(new URL(INV.interviewFormUrl({ installId: "me@example.com", analyticsEnabled: true, doNotTrack: false })).searchParams.has("iid"), false);
});

test("the PostHog flag reply: v2 and the older shape; anything else is off", () => {
  assert.equal(INV.parseFlagReply({ flags: { "interview-invite": { enabled: true } } }, "interview-invite"), true);
  assert.equal(INV.parseFlagReply({ flags: { "interview-invite": { enabled: false } } }, "interview-invite"), false);
  assert.equal(INV.parseFlagReply({ featureFlags: { "interview-invite": "a" } }, "interview-invite"), true);
  for (const b of [null, {}, { flags: {} }, "x"]) assert.equal(INV.parseFlagReply(b, "interview-invite"), false);
});

test("the flag check sends the key and the install id only, and any failure is off", async () => {
  let seen = null;
  const ok = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ flags: { "interview-invite": { enabled: true } } }) }; };
  assert.equal(await INV.fetchInviteFlag(ID, ok), true);
  assert.match(seen.url, /\/flags\/\?v=2$/);
  assert.deepEqual(Object.keys(seen.body).sort(), ["api_key", "distinct_id", "geoip_disable"]);
  assert.equal(seen.body.distinct_id, ID);
  assert.equal(await INV.fetchInviteFlag(ID, async () => ({ ok: false, json: async () => ({}) })), false);
  assert.equal(await INV.fetchInviteFlag(ID, async () => { throw new Error("offline"); }), false);
  const hang = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  assert.equal(await INV.fetchInviteFlag(ID, hang, 20), false, "gives up after the timeout");
});

test("the three events pass the catalogue with fixed words only", () => {
  assert.equal(V.validateEvent("interview_invite_shown", { via: "card" }, "main").props.via, "card");
  for (const via of ["menu", "card", "slash"]) {
    assert.equal(V.validateEvent("interview_invite_clicked", { via }, "main").props.via, via);
  }
  for (const reason of ["later", "never"]) {
    assert.equal(V.validateEvent("interview_invite_dismissed", { reason }, "main").props.reason, reason);
  }
  const extra = V.validateEvent("interview_invite_clicked", { via: "menu", email: "a@b.c" }, "main");
  assert.equal("email" in extra.props, false);
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`Help › Talk to the Team sends help.feedback (${platform})`, () => {
    const sent = [];
    const help = menuTemplate((c) => sent.push(c), platform).find((m) => m.label === "Help");
    const it = help.submenu.find((i) => i.label === "Talk to the Team ($50 Credits)…");
    assert.ok(it, "the Help menu has the item");
    it.click();
    assert.deepEqual(sent, ["help.feedback"]);
  });
}

test("the window keeps the card away during a turn, setup or an error, and before the agent is up", () => {
  const live = { state: "connected", error: null };
  assert.equal(CARD.interviewMayAsk({ live }), true);
  assert.equal(CARD.interviewMayAsk({ live: { state: "starting" } }), false);
  assert.equal(CARD.interviewMayAsk({ live, busy: true }), false);
  assert.equal(CARD.interviewMayAsk({ live, onboarding: true }), false);
  assert.equal(CARD.interviewMayAsk({ live: { state: "connected", error: "boom" } }), false);
  assert.equal(CARD.interviewMayAsk({ live, dlError: { reason: "x" } }), false);
  assert.deepEqual(CARD.interviewWindowState({ live: { state: "error" } }), { busy: false, onboarding: false, error: true });
});

test("the card: hidden unless shown, three buttons, Don't ask again among them", () => {
  assert.equal(CARD.interviewCardHTML(false), "");
  const html = CARD.interviewCardHTML(true);
  assert.match(html, /data-act="interview:card"/);
  assert.match(html, /data-act="interview:later"/);
  assert.match(html, /data-act="interview:never"/);
  assert.match(html, /\$50 in OpenRouter credits/);
});

test("the renderer wires the card, the palette row and /feedback", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('<script src="interview-card.js"') > 0 && html.indexOf('<script src="interview-card.js"') < html.indexOf('<script src="renderer.js"'));
  assert.match(src, /\['feedback','15 min call with the team/);
  assert.match(src, /'help\.feedback'\]/, "a palette row");
  assert.match(src, /if \(a === 'help\.feedback'\) \{ close\(\); render\(\); interviewOpen\('menu'\); return; \}/);
  assert.match(src, /if \(name === 'feedback'\) \{ interviewSlash\(rest\); return; \}/);
  assert.match(src, /interviewCardHTML\(INV\.show && !\(S\.busy \|\| S\.pending\) && !OB\.open\)/, "the card hides while a turn runs or setup is open");
});
