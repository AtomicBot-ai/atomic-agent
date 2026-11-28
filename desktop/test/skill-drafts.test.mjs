// ATO-67: Settings › Skills › "Pending review" for skills learned from outside content.
// Renderer helpers (escaping, grouping, the controller), the main-side argv and
// parsing (against the built output), and the wiring pins.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  skillDraftKindLabel, skillRowsWithoutDrafts, skillDraftsGroup, skillDraftsListHTML, skillDraftDetailHTML,
  skillDraftConfirmHTML, createSkillDraftsController,
} = require("../renderer/workspace-skills.js");
const {
  SKILL_DRAFT_ID_RE, skillDraftListArgs, skillDraftShowArgs, skillDraftActionArgs, parseSkillDrafts, parseSkillDraftShow,
} = require("../out/main/skill-drafts-cli.js");

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const row = (id, over = {}) => ({ id, name: "skill-" + id, kind: "create", reason: "Seen twice in a row", ...over });

test("argv: list, show, approve and discard are arrays, the id one element", () => {
  assert.deepEqual(skillDraftListArgs(), ["skill", "list", "--json"]);
  assert.deepEqual(skillDraftShowArgs("a1b2"), ["skill", "learned", "show", "a1b2", "--json"]);
  assert.deepEqual(skillDraftActionArgs("approve", "a1b2"), ["skill", "learned", "approve", "a1b2"]);
  assert.deepEqual(skillDraftActionArgs("discard", "a1b2"), ["skill", "learned", "discard", "a1b2"]);
});

test("draft ids: short hex passes; a flag, a path, a space or an empty string does not", () => {
  for (const ok of ["a1b2", "0f3c9e", "abc_def-1"]) assert.ok(SKILL_DRAFT_ID_RE.test(ok), ok);
  for (const bad of ["", "-rf", "--json", "../x", "a b", "a;b", "x".repeat(65)]) assert.ok(!SKILL_DRAFT_ID_RE.test(bad), bad);
});

test("skill list --json: only pending rows with a valid id, once each; an older agent's plain list is no drafts", () => {
  const json = JSON.stringify([
    { name: "web-scrape", version: "1.0.0", source: "global", status: "enabled", description: "installed" },
    { name: "old", version: "1.0.0", source: "global", status: "disabled", description: "off" },
    { name: "pr-review", version: "-", source: "learned", status: "pending", description: "Reviewed 3 PRs the same way", draftId: "a1b2", draftKind: "create" },
    { name: "deploy", version: "-", source: "learned", status: "pending", description: "Fix the deploy step", draftId: "c3d4", draftKind: "patch" },
    { name: "dup", status: "pending", draftId: "a1b2", draftKind: "create" },
    { name: "evil", status: "pending", draftId: "--rm", draftKind: "create" },
  ]);
  assert.deepEqual(parseSkillDrafts(json), [
    { id: "a1b2", name: "pr-review", kind: "create", reason: "Reviewed 3 PRs the same way" },
    { id: "c3d4", name: "deploy", kind: "patch", reason: "Fix the deploy step" },
  ]);
  assert.deepEqual(parseSkillDrafts("web-scrape\tv1.0.0\t[global]\tenabled\tinstalled\n"), []);
  assert.deepEqual(parseSkillDrafts(""), []);
  assert.deepEqual(parseSkillDrafts('{"not":"an array"}'), []);
});

test("skill learned show --json: the document, or null", () => {
  const doc = {
    id: "c3d4", kind: "patch", skill: "deploy", path: "/s/deploy/SKILL.md", origin: "turn", sources: ["https://example.com/a", 7],
    reason: "Fix the deploy step", createdAt: 1763450000000, skillMd: "---\nname: deploy\n---\nnew", currentSkillMd: "old", diff: "-old\n+new",
  };
  const d = parseSkillDraftShow(JSON.stringify(doc));
  assert.equal(d.kind, "patch");
  assert.deepEqual(d.sources, ["https://example.com/a"]);
  assert.equal(d.diff, "-old\n+new");
  assert.equal(parseSkillDraftShow(JSON.stringify({ ...doc, kind: "create", currentSkillMd: null, diff: null })).diff, null);
  assert.equal(parseSkillDraftShow("not json"), null);
  assert.equal(parseSkillDraftShow(JSON.stringify({ id: "c3d4" })), null);
});

test("a plain skill list never shows a draft as a disabled skill", () => {
  const rows = [{ name: "a", enabled: true }, { name: "b", enabled: false, status: "pending" }, { name: "c", enabled: false }];
  assert.deepEqual(skillRowsWithoutDrafts(rows).map((r) => r.name), ["a", "c"]);
  assert.deepEqual(skillRowsWithoutDrafts(null), []);
});

test("grouping: Pending review with a count; nothing when there are no drafts", () => {
  assert.equal(skillDraftsGroup([]), null);
  assert.equal(skillDraftsGroup(null), null);
  const g = skillDraftsGroup([row("a1b2"), row("c3d4", { kind: "patch" }), row("a1b2"), row("-x")]);
  assert.equal(g.label, "Pending review");
  assert.equal(g.count, 2);
  assert.deepEqual(g.rows.map((r) => r.kind), ["create", "patch"]);
  assert.equal(skillDraftKindLabel("create"), "New skill");
  assert.equal(skillDraftKindLabel("patch"), "Update");
  assert.equal(skillDraftsListHTML({ rows: [] }, esc), "");
});

test("the group escapes the model's reason and the skill name, and offers Show / Approve / Discard", () => {
  const html = skillDraftsListHTML({ rows: [row("a1b2", { name: '<img src=x onerror="alert(1)">', reason: "<script>alert(1)</script> & more" })] }, esc);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /Pending review/);
  assert.match(html, /data-skill-drafts="1"/);
  assert.match(html, /New skill/);
  assert.match(html, /data-act="skills:draft:show:a1b2"[^>]*>Show</);
  assert.match(html, /data-act="skills:draft:approve:a1b2"[^>]*>Approve</);
  assert.match(html, /data-act="skills:draft:discard:a1b2"[^>]*>Discard</);
  assert.match(skillDraftsListHTML({ rows: [row("a1b2")], busyId: "a1b2" }, esc), /approve:a1b2" disabled/);
});

test("the preview: a diff for an update, the SKILL.md for a new skill, the sources, all escaped and read-only", () => {
  const draft = { id: "c3d4", kind: "patch", skill: "deploy", path: "/s/deploy/SKILL.md", sources: ["https://e.com/?q=<b>"], reason: "r", skillMd: "full", diff: "-<old>\n+new" };
  const patch = skillDraftDetailHTML({ open: { id: "c3d4", draft } }, esc);
  assert.match(patch, /data-skill-draft-preview="diff">-&lt;old&gt;\n\+new</);
  assert.match(patch, /Learned from:/);
  assert.match(patch, /https:\/\/e\.com\/\?q=&lt;b&gt;/);
  assert.match(patch, /\(read-only\)/);
  assert.ok(!/<textarea|contenteditable/.test(patch));
  const create = skillDraftDetailHTML({ open: { id: "a1b2", draft: { ...draft, id: "a1b2", kind: "create", diff: null, sources: [] } } }, esc);
  assert.match(create, /data-skill-draft-preview="skill">full</);
  assert.match(create, /No sources were recorded\./);
  assert.match(skillDraftDetailHTML({ open: { id: "a1b2", draft: null, error: "gone <now>" } }, esc), /gone &lt;now&gt;/);
  assert.equal(skillDraftDetailHTML({ open: null }, esc), "");
});

test("Discard asks first, like Remove skill", () => {
  assert.equal(skillDraftConfirmHTML({ confirm: null }, esc), "");
  const html = skillDraftConfirmHTML({ confirm: { id: "a1b2", name: "<x>", submitting: false, error: null } }, esc);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /data-act="skills:draft:cancel"/);
  assert.match(html, /data-act="skills:draft:discardConfirm"/);
});

test("controller: show, approve and discard call the bridge and re-read the list", async () => {
  const calls = [];
  let rows = [row("a1b2"), row("c3d4", { kind: "patch" })];
  const br = {
    skillDrafts: async () => (calls.push(["list"]), { ok: true, rows }),
    skillDraftShow: async (id) => (calls.push(["show", id]), { ok: true, draft: { id, kind: "create", skillMd: "x", sources: [] } }),
    skillDraftApprove: async (id) => (calls.push(["approve", id]), (rows = rows.filter((r) => r.id !== id)), { ok: true }),
    skillDraftDiscard: async (id) => (calls.push(["discard", id]), (rows = rows.filter((r) => r.id !== id)), { ok: true }),
  };
  let changed = 0, t = 0;
  const c = createSkillDraftsController({ api: () => br, paint: () => {}, changed: () => changed++, now: () => t });
  await c.refresh(true);
  assert.equal(c.state.rows.length, 2);
  await c.refresh(); // throttled: no second read inside 15 s
  assert.equal(calls.filter((x) => x[0] === "list").length, 1);
  await c.act("show:a1b2");
  assert.equal(c.state.open.draft.id, "a1b2");
  await c.act("approve:a1b2");
  assert.equal(changed, 1);
  assert.equal(c.state.open, null);
  assert.deepEqual(c.state.rows.map((r) => r.id), ["c3d4"]);
  c.act("discard:c3d4");
  assert.equal(c.state.confirm.id, "c3d4");
  assert.ok(!calls.some((x) => x[0] === "discard"), "nothing is discarded before the confirm");
  c.act("cancel");
  assert.equal(c.state.confirm, null);
  c.act("discard:c3d4");
  await c.act("discardConfirm");
  assert.deepEqual(calls.filter((x) => x[0] !== "list"), [["show", "a1b2"], ["approve", "a1b2"], ["discard", "c3d4"]]);
  assert.equal(c.state.rows.length, 0);
  c.act("show:--bad");
  assert.equal(c.state.open, null);
});

test("controller: a failed approve says so; an older agent (no bridge, or a failed read) is an empty group", async () => {
  const c = createSkillDraftsController({ api: () => ({ skillDrafts: async () => ({ ok: true, rows: [row("a1b2")] }), skillDraftApprove: async () => ({ ok: false, error: "no such draft" }) }), paint: () => {} });
  await c.refresh(true);
  await c.act("approve:a1b2");
  // ATO-2745: a plain line; the agent's own words ("no such draft") sit behind Details.
  assert.equal(c.state.error, 'Could not approve "skill-a1b2". It is still waiting for review.');
  assert.equal(c.state.errorDetail, "no such draft");
  assert.match(skillDraftsListHTML(c.state, esc), /<details class="set-errmore"><summary>Details<\/summary><span>no such draft<\/span><\/details>/);
  const old = createSkillDraftsController({ api: () => null, paint: () => {} });
  await old.refresh(true);
  assert.deepEqual(old.state.rows, []);
  const failed = createSkillDraftsController({ api: () => ({ skillDrafts: async () => { throw new Error("x"); } }), paint: () => {} });
  await failed.refresh(true);
  assert.deepEqual(failed.state.rows, []);
});

test("wiring: preload, IPC, main, the CLI filter and the Skills tab", () => {
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /skillDrafts: \(\) => ipcRenderer\.invoke\("cli:skillDrafts"\)/);
  assert.match(preload, /skillDraftShow: \(id: string\) => ipcRenderer\.invoke\("cli:skillDraftShow", id\)/);
  assert.match(preload, /skillDraftApprove: \(id: string\) => ipcRenderer\.invoke\("cli:skillDraftApprove", id\)/);
  assert.match(preload, /skillDraftDiscard: \(id: string\) => ipcRenderer\.invoke\("cli:skillDraftDiscard", id\)/);
  const ipc = readFileSync(new URL("../main/skill-drafts-ipc.ts", import.meta.url), "utf8");
  for (const ch of ["cli:skillDrafts", "cli:skillDraftShow", "cli:skillDraftApprove", "cli:skillDraftDiscard"]) assert.ok(ipc.includes(`ipcMain.handle("${ch}"`), ch);
  assert.ok(!/exec\(|shell:\s*true/.test(ipc), "argv arrays only, no shell");
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /wireSkillDraftsIpc\(\{ cwd: \(\) => client\.status\.workingDir, isRemote: \(\) => client\.isRemote \}\)/);
  assert.match(main, /status !== "pending"/);
  const cli = readFileSync(new URL("../main/agent-cli.ts", import.meta.url), "utf8");
  assert.match(cli, /if \(cells\[3\] === "pending"\) continue;/);
  const r = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(r, /const SKD = createSkillDraftsController\(/);
  assert.match(r, /SKD\.listHTML\(esc\) \+ skpListHTML\(visible\)/);
  assert.match(r, /SKD\.state\.open \? SKD\.detailHTML\(esc\)/);
  assert.match(r, /SKD\.confirmHTML\(esc\)/);
  assert.match(r, /if \(verb === 'draft'\) \{ SKD\.act\(arg\); return; \}/);
  assert.match(r, /SK\.rows = skillRowsWithoutDrafts\(res\.rows\)/);
});

// ATO-2745: the loading state is a sentence (was "(loading…)"), Discard says what it is doing
// (was "discarding…"), and no line ends in "no answer".
test("ATO-2745: loading and discarding states in words, errors with Details", async () => {
  const loading = skillDraftDetailHTML({ open: { id: "a1b2", draft: null, error: null } }, esc);
  assert.match(loading, /role="status"><span class="tk-spin"><\/span>Loading the draft…<\/div>/);
  assert.doesNotMatch(loading, /\(loading…\)/);
  const discarding = skillDraftConfirmHTML({ confirm: { id: "a1b2", name: "x", submitting: true, error: null } }, esc);
  assert.match(discarding, /Discarding the draft…/);
  assert.doesNotMatch(discarding, />discarding…</);
  const silent = createSkillDraftsController({ api: () => ({ skillDrafts: async () => ({ ok: true, rows: [row("a1b2")] }), skillDraftApprove: async () => null }), paint: () => {} });
  await silent.refresh(true);
  await silent.act("approve:a1b2");
  assert.doesNotMatch(silent.state.error, /no answer/);
  assert.equal(silent.state.errorDetail, "The agent did not answer.");
  const shown = createSkillDraftsController({ api: () => ({ skillDrafts: async () => ({ ok: true, rows: [row("a1b2")] }), skillDraftShow: async () => ({ ok: false, error: "ENOENT draft.json" }) }), paint: () => {} });
  await shown.refresh(true);
  await shown.act("show:a1b2");
  assert.equal(shown.state.open.error, "Could not open this draft. Close it and try again.");
  assert.match(skillDraftDetailHTML(shown.state, esc), /<summary>Details<\/summary><span>ENOENT draft\.json<\/span>/);
  const disc = createSkillDraftsController({ api: () => ({ skillDrafts: async () => ({ ok: true, rows: [row("a1b2")] }), skillDraftDiscard: async () => ({ ok: false, error: "locked" }) }), paint: () => {} });
  await disc.refresh(true);
  disc.act("discard:a1b2");
  await disc.act("discardConfirm");
  assert.equal(disc.state.confirm.error, "Could not discard the draft. It is still waiting for review.");
  assert.equal(disc.state.confirm.errorDetail, "locked");
});
