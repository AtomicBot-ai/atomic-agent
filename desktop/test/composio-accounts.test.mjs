// ATO-1494: Settings › Connections › Composio › Accounts. Main side against
// the built output (main/composio-accounts.ts, main/composio-accounts-ipc.ts):
// the core's list rules, the pins and stamp the agent uses, the Composio
// account listing, and the IPC edits. Renderer side from
// renderer/composio-accounts.js: rows, markup and the controller. Every
// effect is faked; every key is a dummy. Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../out/main/composio-accounts.js");
const I = require("../out/main/composio-accounts-ipc.js");
const R = require("../renderer/composio-accounts.js");
const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const h = { esc, ic: (n) => "<i:" + n + ">" };
const KEY = "ak_dummy0123456789abcdef";

const WORK = { toolkit: "gmail", alias: "work", connectedAccountId: "ca_work", isDefault: true };
const HOME = { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home", isDefault: false };

/* ---------------- the list rules (src/composio/composio-accounts.ts) ---------------- */

test("add lowercases the app, refuses a bad name, a duplicate name or a saved account", () => {
  const added = A.addAccount([], { toolkit: " Gmail ", alias: "work", connectedAccountId: "ca_work" });
  assert.deepEqual(added, { ok: true, accounts: [{ ...WORK, isDefault: false }] });
  assert.equal(A.addAccount([], { toolkit: "gmail", alias: "Work Mail", connectedAccountId: "ca_1" }).ok, false);
  assert.equal(A.addAccount([WORK], { toolkit: "gmail", alias: "work", connectedAccountId: "ca_2" }).ok, false);
  assert.equal(A.addAccount([WORK], { toolkit: "gmail", alias: "other", connectedAccountId: "ca_work" }).ok, false);
  assert.equal(A.addAccount([], { toolkit: "gmail", alias: "w", connectedAccountId: "ca 1" }).ok, false);
});

test("a new default replaces the old one for that app only", () => {
  const slack = { toolkit: "slack", alias: "team", connectedAccountId: "ca_slack", isDefault: true };
  const r = A.addAccount([WORK, slack], { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home", isDefault: true });
  assert.deepEqual(r.accounts.map((a) => [a.alias, a.isDefault]), [["work", false], ["team", true], ["home", true]]);
});

test("set default moves it, null clears it, an unknown name is an error; remove drops one", () => {
  const moved = A.setDefaultAccount([WORK, HOME], { toolkit: "gmail", alias: "home" });
  assert.deepEqual(moved.accounts.map((a) => a.isDefault), [false, true]);
  const cleared = A.setDefaultAccount([WORK, HOME], { toolkit: "gmail", alias: null });
  assert.ok(cleared.accounts.every((a) => !a.isDefault));
  assert.equal(A.setDefaultAccount([WORK], { toolkit: "gmail", alias: "nope" }).ok, false);
  assert.deepEqual(A.removeAccount([WORK, HOME], { toolkit: "gmail", alias: "work" }).accounts, [HOME]);
  assert.equal(A.removeAccount([WORK], { toolkit: "gmail", alias: "nope" }).ok, false);
});

test("readAccounts takes the config block as `config get composio` answers it and drops junk", () => {
  assert.deepEqual(A.readAccounts({ accounts: [WORK, { toolkit: 1 }, null] }), [WORK]);
  assert.deepEqual(A.readAccounts({}), []);
  assert.deepEqual(A.readAccounts(null), []);
});

test("pins and stamp match the core's: sorted, null with nothing pinned", () => {
  const slack = { toolkit: "slack", alias: "team", connectedAccountId: "ca_slack", isDefault: true };
  const pins = A.composioSessionPins([slack, HOME, WORK]);
  assert.deepEqual(pins, { gmail: ["ca_work"], slack: ["ca_slack"] });
  assert.deepEqual(Object.keys(pins), ["gmail", "slack"]);
  assert.equal(A.composioSessionStamp("trs_1", pins), "trs_1#gmail=ca_work,slack=ca_slack");
  assert.equal(A.composioSessionStamp("trs_1", {}), null);
});

test("listConnectedAccounts asks for this user's ACTIVE accounts with the key header", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ items: [
      { id: "ca_work", toolkit: { slug: "GMAIL" }, status: "ACTIVE", state: { val: { displayName: "me@work.test" } } },
      { id: "ca_x" },
    ] }), { status: 200 });
  };
  const list = await A.listConnectedAccounts({ apiKey: KEY, userId: "u-1", fetchImpl });
  assert.deepEqual(list, [{ id: "ca_work", toolkit: "gmail", status: "ACTIVE", displayName: "me@work.test" }]);
  assert.match(calls[0].url, /\/connected_accounts\?user_ids=u-1&statuses=ACTIVE&limit=100$/);
  assert.equal(calls[0].init.headers["x-api-key"], KEY);
  await assert.rejects(A.listConnectedAccounts({ apiKey: KEY, userId: "u", fetchImpl: async () => new Response("{}", { status: 401 }) }), /rejected the API key/);
});

/* ---------------- IPC (main/composio-accounts-ipc.ts) ---------------- */

function ipcDeps(over = {}) {
  const config = { userId: "u-1", accounts: [WORK], ...(over.config ?? {}) };
  const writes = [];
  return {
    writes, config,
    d: {
      env: over.env ?? { COMPOSIO_API_KEY: KEY },
      readComposio: async () => ({ ok: true, value: { ...config } }),
      writeAccounts: async (accounts) => { writes.push(accounts); config.accounts = accounts; return { ok: true }; },
      listConnected: over.listConnected ?? (async () => [{ id: "ca_home", toolkit: "gmail", status: "ACTIVE", displayName: null }]),
    },
  };
}

test("listAccounts: the saved list plus Composio's, and why Composio could not be asked", async () => {
  const ok = await I.listComposioAccounts(ipcDeps().d, null);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.accounts, [WORK]);
  assert.equal(ok.connected.length, 1);
  const noKey = await I.listComposioAccounts(ipcDeps({ env: {} }).d, null);
  assert.equal(noKey.connected, null);
  assert.match(noKey.connectedError, /No Composio API key/);
  const down = await I.listComposioAccounts(ipcDeps({ listConnected: async () => { throw new Error("offline"); } }).d, null);
  assert.equal(down.ok, true, "the saved list still shows");
  assert.match(down.connectedError, /offline/);
  assert.ok(!JSON.stringify([ok, noKey, down]).includes(KEY), "the key never comes back");
});

test("edits write the whole list once and refuse what the core refuses", async () => {
  const { d, writes } = ipcDeps();
  const added = await I.editComposioAccounts(d, A.addAccount, { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home" });
  assert.equal(added.ok, true);
  const def = await I.editComposioAccounts(d, A.setDefaultAccount, { toolkit: "gmail", alias: "home" });
  assert.deepEqual(def.accounts.map((a) => [a.alias, a.isDefault]), [["work", false], ["home", true]]);
  const bad = await I.editComposioAccounts(d, A.removeAccount, { toolkit: "gmail", alias: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(writes.length, 2, "a refused edit writes nothing");
});

test("the four channels are registered", () => {
  const seen = [];
  I.registerComposioAccountsIpc({ ipcMain: { handle: (c) => seen.push(c) }, ownDir: () => true, deps: ipcDeps().d });
  assert.deepEqual(seen, ["composio:listAccounts", "composio:addAccount", "composio:removeAccount", "composio:setDefault"]);
});

/* ---------------- renderer (renderer/composio-accounts.js) ---------------- */

test("names are lowercased, spaces become '-', and the core's rule decides", () => {
  assert.equal(R.cmpaAliasClean(" Work Mail "), "work-mail");
  assert.equal(R.cmpaAliasClean(""), "");
  assert.equal(R.cmpaAliasClean("-x"), null);
  assert.equal(R.cmpaAliasClean("x".repeat(33)), null);
});

test("rows: saved accounts first per app, then signed-in ones not saved; a vanished one is flagged", () => {
  const rows = R.cmpaRows([WORK, { ...HOME, connectedAccountId: "ca_gone" }], [
    { id: "ca_work", toolkit: "gmail", displayName: "me@work.test" },
    { id: "ca_new", toolkit: "gmail", displayName: null },
  ]);
  assert.deepEqual(rows.map((r) => [r.alias, r.id, r.missing]), [["home", "ca_gone", true], ["work", "ca_work", false], [null, "ca_new", false]]);
});

test("markup: default chip, make-default, remove and save buttons; nothing unescaped", () => {
  const html = R.composioAccountsHTML({ accounts: [WORK, HOME], connected: [{ id: "ca_new", toolkit: "gmail", displayName: '<b>"x"</b>' }], drafts: {} }, h);
  assert.ok(html.includes("Default"));
  assert.ok(html.includes('data-act="composio:acct:default:gmail:home"'));
  assert.ok(html.includes('data-act="composio:acct:remove:gmail:work"'));
  assert.ok(html.includes('data-act="composio:acct:clear:gmail"'));
  assert.ok(html.includes('data-act="composio:acct:save:gmail:ca_new"'));
  assert.ok(!html.includes("<b>"));
  assert.ok(!html.includes("—"));
});

test("controller: saving a name makes the app's first account its default, then owes a restart", async () => {
  const calls = [];
  const said = [];
  const br = {
    composioListAccounts: async () => ({ ok: true, accounts: [], connected: [{ id: "ca_new", toolkit: "gmail", displayName: null }] }),
    composioAddAccount: async (input) => { calls.push(input); return { ok: true, accounts: [{ ...input }] }; },
  };
  const c = R.createComposioAccounts({ bridge: () => br, stateDir: () => "/s", repaint: () => {}, changed: (t) => said.push(t) });
  await c.refresh();
  c.draft("ca_new", "Work");
  await c.act("save:gmail:ca_new");
  assert.deepEqual(calls, [{ toolkit: "gmail", alias: "work", connectedAccountId: "ca_new", isDefault: true }]);
  assert.equal(said.length, 1);
  assert.equal(c.state.drafts.ca_new, undefined);
  await c.act("save:gmail:ca_other");
  assert.match(c.state.error, /Type a name/);
});

test("renderer wiring: loads before composio.js, hooked into the pane, its verbs and tab entry", () => {
  const helper = index.indexOf('<script src="composio-accounts.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="composio.js">'));
  for (const hook of ["const CMPA = createComposioAccounts(", "accounts: CMPA.view()", "CMPA.refresh(); }", "if (verb === 'acct') { CMPA.act("]) {
    assert.ok(source.includes(hook), hook);
  }
});
