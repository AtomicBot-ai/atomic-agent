// Unit tests for ATO-1754 (Fusion models by role in the desktop):
// main/fusion-roles.ts (against the built output), the pure half of
// renderer/fusion-roles.js that builds the rows, and the wiring read from
// the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/fusion-roles.js");
const R = require("../renderer/fusion-roles.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PROVIDERS = [
  { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-5" },
  { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "box", kind: "llama-server", url: "http://10.0.0.5:8080", model: "qwen3-coder" },
  { id: "local-llama", kind: "llama-server" },
];
const cfgWith = (fusion) => ({ llm: { activeTextProvider: "openrouter", providers: PROVIDERS, runMode: { mode: "fusion", fusion } } });
const pin = (role, providerId, model) => M.parseFusionRoleRequest({ role, providerId, ...(model === undefined ? {} : { model }) });

/* ---------- the write plan (main) ---------- */

test("a role pinned with a model writes roles and roleModels, every other fusion key kept", () => {
  const cfg = cfgWith({ workers: 3, workerReasoning: "low", roles: { build: "lmstudio" } });
  const v = M.planFusionRole(cfg, pin("review", "openrouter", "deepseek/deepseek-v4.1"));
  assert.equal(v.write, true);
  assert.deepEqual(v.before, { providerId: null, model: null });
  assert.deepEqual(v.after, { providerId: "openrouter", model: "deepseek/deepseek-v4.1" });
  assert.deepEqual(cfg.llm.runMode.fusion, {
    workers: 3, workerReasoning: "low",
    roles: { build: "lmstudio", review: "openrouter" },
    roleModels: { review: "deepseek/deepseek-v4.1" },
  });
  assert.equal(cfg.llm.runMode.mode, "fusion");
  assert.equal(cfg.llm.activeTextProvider, "openrouter");
});

test("two roles share one provider with a model each", () => {
  const cfg = cfgWith({ roles: { review: "openrouter" }, roleModels: { review: "a/model" } });
  M.planFusionRole(cfg, pin("explore", "openrouter", "b/model"));
  assert.deepEqual(cfg.llm.runMode.fusion.roles, { review: "openrouter", explore: "openrouter" });
  assert.deepEqual(cfg.llm.runMode.fusion.roleModels, { review: "a/model", explore: "b/model" });
});

test("moving a role to another provider without a model drops the old model", () => {
  const cfg = cfgWith({ roles: { review: "openrouter" }, roleModels: { review: "a/model" } });
  const v = M.planFusionRole(cfg, pin("review", "lmstudio"));
  assert.equal(v.write, true);
  assert.deepEqual(cfg.llm.runMode.fusion, { roles: { review: "lmstudio" } });
});

test("the same provider with no model keeps no model (its default runs)", () => {
  const cfg = cfgWith({ roles: { build: "openrouter" }, roleModels: { build: "a/model" } });
  assert.equal(M.planFusionRole(cfg, pin("build", "openrouter", "  ")).write, true);
  assert.deepEqual(cfg.llm.runMode.fusion, { roles: { build: "openrouter" } });
});

test("clearing a role removes both keys and writes no empty map", () => {
  const cfg = cfgWith({ workers: 2, roles: { review: "openrouter" }, roleModels: { review: "a/model" } });
  const v = M.planFusionRole(cfg, pin("review", null));
  assert.equal(v.write, true);
  assert.deepEqual(v.after, { providerId: null, model: null });
  assert.deepEqual(cfg.llm.runMode.fusion, { workers: 2 });
});

test("a role a newer build added is kept, with its model", () => {
  const cfg = cfgWith({ roles: { design: "openrouter", build: "lmstudio" }, roleModels: { design: "x/y" } });
  M.planFusionRole(cfg, pin("build", null));
  assert.deepEqual(cfg.llm.runMode.fusion, { roles: { design: "openrouter" }, roleModels: { design: "x/y" } });
});

test("a llama-server entry gets no model name: it serves what it loaded", () => {
  const cfg = cfgWith({});
  const v = M.planFusionRole(cfg, pin("build", "box", "something-else"));
  assert.deepEqual(v.after, { providerId: "box", model: null });
  assert.deepEqual(cfg.llm.runMode.fusion, { roles: { build: "box" } });
});

test("nothing is written when the role already says the same", () => {
  const same = cfgWith({ roles: { review: "openrouter" }, roleModels: { review: "a/model" } });
  assert.equal(M.planFusionRole(same, pin("review", "openrouter", "a/model")).write, false);
  const unset = cfgWith({ workers: 2 });
  assert.equal(M.planFusionRole(unset, pin("plan", null)).write, false);
  assert.deepEqual(unset.llm.runMode.fusion, { workers: 2 });
});

test("a provider that is not set up, or no llm block, is refused and nothing changes", () => {
  const cfg = cfgWith({ workers: 2 });
  const v = M.planFusionRole(cfg, pin("review", "gone"));
  assert.equal(v.write, false);
  assert.ok(v.refusal);
  assert.deepEqual(cfg.llm.runMode.fusion, { workers: 2 });
  const bare = { localModels: {} };
  assert.ok(M.planFusionRole(bare, pin("review", "openrouter")).refusal);
  assert.equal("llm" in bare, false);
});

test("a file with no runMode block gets one with only the role", () => {
  const cfg = { llm: { providers: PROVIDERS } };
  M.planFusionRole(cfg, pin("utility", "openrouter", "small/model"));
  assert.deepEqual(cfg.llm.runMode, { fusion: { roles: { utility: "openrouter" }, roleModels: { utility: "small/model" } } });
});

test("the IPC argument is read strictly", () => {
  assert.deepEqual(M.parseFusionRoleRequest({ role: "review", providerId: "openrouter", model: " m " }), { role: "review", pin: { providerId: "openrouter", model: "m" } });
  assert.deepEqual(M.parseFusionRoleRequest({ role: "plan", providerId: "" }), { role: "plan", pin: null });
  assert.equal(M.parseFusionRoleRequest({ role: "judge", providerId: "openrouter" }), null);
  assert.equal(M.parseFusionRoleRequest({ role: "plan", providerId: 3 }), null);
  assert.equal(M.parseFusionRoleRequest({ role: "plan", providerId: "openrouter", model: 3 }), null);
  assert.equal(M.parseFusionRoleRequest(null), null);
});

test("the plan follows the agent's own rule (src/config/fusion-role-pin.ts)", () => {
  const core = readFileSync(new URL("../../src/config/fusion-role-pin.ts", import.meta.url), "utf8");
  assert.ok(core.includes("delete nextRoles[role];") && core.includes("delete nextModels[role];"));
  const fusion = { roles: { review: "a" }, roleModels: { review: "m" }, workers: 2 };
  assert.deepEqual(M.withFusionRolePin(fusion, "review", { providerId: "b" }), { workers: 2, roles: { review: "b" } });
  assert.deepEqual(M.withFusionRolePin(fusion, "review", null), { workers: 2 });
});

/* ---------- the rows (renderer) ---------- */

const word = (id) => ({ openrouter: "OpenRouter", lmstudio: "LM Studio" }[id] || id);

test("one row per role in the agent's order, unset roles on the workers' model", () => {
  const rows = R.fzroleRows(cfgWith({}), { workerModel: "qwen3-8b" }, {}, word);
  assert.deepEqual(rows.map((r) => r.role), ["plan", "build", "review", "explore", "utility"]);
  for (const r of rows) {
    assert.equal(r.mode, "workers");
    assert.equal(r.providerOptions[0].value, "");
    assert.equal(r.providerOptions[0].label, "Workers’ model (default)");
    assert.equal(r.providerOptions[0].selected, true);
    assert.equal(r.note, "Runs on qwen3-8b");
    assert.ok(r.help.length > 0);
  }
  assert.deepEqual(rows[0].providerOptions.slice(1).map((o) => o.label), ["OpenRouter", "LM Studio", "box", "local-llama"]);
});

test("a cloud role lists the provider's models, its saved one selected even before the list loads", () => {
  const cfg = cfgWith({ roles: { review: "openrouter" }, roleModels: { review: "a/model" } });
  const loading = R.fzroleRows(cfg, {}, {}, word).find((r) => r.role === "review");
  assert.equal(loading.mode, "list");
  assert.equal(loading.status, "loading");
  assert.equal(loading.modelOptions[0].label, "Default (openai/gpt-5)");
  assert.deepEqual(loading.modelOptions.filter((o) => o.selected).map((o) => o.value), ["a/model"]);
  const lists = { openrouter: { status: "ready", models: [{ id: "b/model" }, { id: "a/model" }, { id: "e/embed", kind: "embedding" }] } };
  const ready = R.fzroleRows(cfg, {}, lists, word).find((r) => r.role === "review");
  assert.deepEqual(ready.modelOptions.map((o) => o.value), ["", "b/model", "a/model"]);
  assert.equal(ready.note, "");
});

test("a llama-server role shows the loaded model instead of a list", () => {
  const cfg = cfgWith({ roles: { build: "box", explore: "local-llama" }, roleModels: { build: "ignored" } });
  const rows = R.fzroleRows(cfg, {}, {}, word);
  const build = rows.find((r) => r.role === "build");
  assert.equal(build.mode, "server");
  assert.equal(build.note, "Loaded on the server: qwen3-coder");
  assert.equal(build.modelOptions.length, 0);
  assert.ok(!R.fzroleRowHTML(build, null).includes("data-fzrole-model"));
  assert.equal(rows.find((r) => r.role === "explore").mode, "local");
});

test("the list's loading, error and empty states are one line of the same shape", () => {
  const cfg = cfgWith({ roles: { build: "lmstudio" } });
  const at = (lists) => R.fzroleRows(cfg, {}, lists, word).find((r) => r.role === "build");
  const err = at({ lmstudio: { status: "error", models: [], line: "The model list from LM Studio did not load.", detail: "fetch failed" } });
  const html = R.fzroleRowHTML(err, null);
  assert.ok(html.includes('class="fzrole-line fzrole-line--err"'));
  assert.ok(html.includes('data-fzrole-retry="lmstudio"'));
  assert.ok(html.includes("<summary>Details</summary><span>fetch failed</span>"));
  assert.equal(html.indexOf("fetch failed") > html.indexOf("Details"), true);
  const empty = at({ lmstudio: { status: "ready", models: [] } });
  assert.ok(R.fzroleRowHTML(empty, null).includes('class="fzrole-line"'));
  assert.ok(R.fzroleRowHTML(at({}), null).includes('class="fzrole-line"><span class="tk-spin"></span>'));
  // The model list waits while its models load.
  assert.ok(/data-fzrole-model="build"[^>]* disabled/.test(R.fzroleRowHTML(at({}), null)));
});

test("review mentions the judge only while the judge has no model of its own", () => {
  const plain = R.fzroleRows(cfgWith({}), {}, {}, word).find((r) => r.role === "review");
  assert.ok(plain.help.endsWith(R.FZROLE_JUDGE_NOTE));
  const pinned = R.fzroleRows(cfgWith({ judgeProvider: "openrouter" }), {}, {}, word).find((r) => r.role === "review");
  assert.ok(!pinned.help.includes("judge"));
});

test("a write in flight disables every list; saved and failed lines read plainly", () => {
  const rows = R.fzroleRows(cfgWith({}), {}, {}, word);
  const busy = R.fzroleSectionHTML(rows, { busy: "plan", msg: null, err: null }, null, null);
  assert.equal((busy.match(/<select /g) || []).length, (busy.match(/<select [^>]* disabled>/g) || []).length);
  const failed = R.fzroleSectionHTML(rows, { busy: null, msg: null, err: R.fzroleErrorOf({ ok: false, error: "exit 1: boom" }) }, null, null);
  assert.ok(failed.includes("This role was not saved. Try again."));
  assert.ok(failed.includes("<summary>Details</summary><span>exit 1: boom</span>"));
  assert.equal(R.fzroleErrorOf({ ok: false, refusal: "That provider is no longer set up. Pick another one." }).detail, "");
  const saved = R.fzroleSectionHTML(rows, { busy: null, msg: "Review: a on OpenRouter.", err: null }, (t) => "<restart>" + t + "</restart>", null);
  assert.ok(saved.includes("<restart>Review: a on OpenRouter.</restart>"));
  assert.equal(R.fzroleSavedLine("review", { providerId: "openrouter", model: "a/model" }, word), "Review: a/model on OpenRouter.");
  assert.equal(R.fzroleSavedLine("build", { providerId: "lmstudio", model: null }, word), "Build: the default model on LM Studio.");
  assert.equal(R.fzroleSavedLine("plan", { providerId: null, model: null }, word), "Plan now runs on the workers’ model.");
  assert.deepEqual(R.fzroleRequest("plan", "", "x"), { role: "plan", providerId: null });
  assert.deepEqual(R.fzroleRequest("plan", "openrouter", "x"), { role: "plan", providerId: "openrouter", model: "x" });
});

test("no long dash in any text the rows show", () => {
  const all = src("../renderer/fusion-roles.js") + src("../main/fusion-roles.ts") + src("../main/fusion-roles-ipc.ts");
  assert.equal(all.includes("—"), false);
});

/* ---------- wiring ---------- */

test("the script, the stylesheet, the bridge, the route and the Settings row are wired", () => {
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('<script src="fusion-roles.js"></script>') > 0);
  assert.ok(html.indexOf('<script src="fusion-roles.js"></script>') < html.indexOf('<script src="renderer.js"></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="css/fusion-roles.css">'));
  assert.ok(src("../preload/preload.ts").includes('fusionRole: (req: { role: string; providerId: string | null; model?: string }) => ipcRenderer.invoke("cli:fusionRole", req)'));
  const main = src("../main/main.ts");
  assert.ok(main.includes('import { wireFusionRolesIpc } from "./fusion-roles-ipc.js";'));
  assert.ok(main.includes("wireFusionRolesIpc();"));
  const ipc = src("../main/fusion-roles-ipc.ts");
  assert.ok(ipc.includes('ipcMain.handle("cli:fusionRole"'));
  // The compare-and-swap write of the whole file (ATO-416), as the worker reasoning level.
  assert.ok(ipc.includes("rewriteWholeConfig((cfg) => planFusionRole(cfg, req))"));
  assert.ok(src("../renderer/renderer.js").includes("llmWorkersHTML(rm) + fzrSettingsHTML(rm) + fzRolesSettingsHTML(rm)"));
});

test("Default names the planner's model on the planner's provider, as the agent runs it", () => {
  const cfg = cfgWith({ orchestratorProvider: "openrouter", orchestratorModel: "O", roles: { review: "openrouter" } });
  const rm = { orchestratorProviderId: "openrouter", orchestratorModel: "O", workerProviderId: "local-llama", workerModel: "qwen3-8b" };
  const review = R.fzroleRows(cfg, rm, { openrouter: { status: "ready", models: [] } }, word).find((r) => r.role === "review");
  assert.match(review.modelOptions[0].label, /O, the planner’s model/);
  assert.doesNotMatch(review.modelOptions[0].label, /gpt-5/);
  assert.equal(R.fzroleSavedLine("review", { providerId: "openrouter", model: null }, word, cfg, rm),
    "Review: O (the planner’s model) on OpenRouter.");
});

test("Default names the workers' model on the workers' provider", () => {
  const cfg = cfgWith({ roles: { build: "lmstudio" } });
  const rm = { orchestratorProviderId: "openrouter", workerProviderId: "lmstudio", workerModel: "W" };
  const build = R.fzroleRows(cfg, rm, {}, word).find((r) => r.role === "build");
  assert.match(build.modelOptions[0].label, /W, the workers’ model/);
  assert.equal(R.fzroleSavedLine("build", { providerId: "lmstudio", model: null }, word, cfg, rm),
    "Build: W (the workers’ model) on LM Studio.");
});

test("elsewhere Default is still the entry's own default", () => {
  const cfg = cfgWith({ roles: { review: "openrouter" } });
  const rm = { orchestratorProviderId: "lmstudio", workerProviderId: "local-llama", workerModel: "qwen3-8b" };
  const review = R.fzroleRows(cfg, rm, {}, word).find((r) => r.role === "review");
  assert.equal(review.modelOptions[0].label, "Default (openai/gpt-5)");
});

test("a second llama-server role says it runs on the workers' model unless mixLocalModels is set", () => {
  const rm = { orchestratorProviderId: "openrouter", workerProviderId: "local-llama", workerModel: "qwen3-8b" };
  const held = R.fzroleRows(cfgWith({ roles: { review: "box" } }), rm, {}, word).find((r) => r.role === "review");
  assert.equal(held.secondLocal, true);
  assert.match(held.note, /^Runs on the workers’ model \(qwen3-8b\)/);
  assert.match(held.note, /one local model at a time/);
  assert.doesNotMatch(R.fzroleRowHTML(held, null), /title=/);
  assert.match(R.fzroleSavedLine("review", { providerId: "box", model: null }, word, cfgWith({ roles: { review: "box" } }), rm),
    /runs on the workers’ model/);
  const mixed = R.fzroleRows(cfgWith({ roles: { review: "box" }, mixLocalModels: true }), rm, {}, word).find((r) => r.role === "review");
  assert.equal(mixed.secondLocal, undefined);
  assert.match(mixed.note, /Loaded on the server: qwen3-coder/);
  // No local leg held (both legs in the cloud): the server's own model runs.
  const cloud = { orchestratorProviderId: "openrouter", workerProviderId: "lmstudio", workerModel: "W" };
  const free = R.fzroleRows(cfgWith({ roles: { review: "box" } }), cloud, {}, word).find((r) => r.role === "review");
  assert.match(free.note, /Loaded on the server/);
});
