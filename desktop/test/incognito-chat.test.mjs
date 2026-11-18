// Unit tests for ATO-586 (incognito chat in the window): the pure half of
// renderer/incognito-chat.js, main/incognito-chats.ts and the chat request
// AgentClient sends (against the built output), and the wiring read from
// the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../renderer/incognito-chat.js");
const M = require("../out/main/incognito-chats.js");
const { AgentClient } = require("../out/main/agent-client.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const h = { esc: (s) => String(s), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>" };
const reset = () => Object.assign(I.INCOG, { armed: false, id: null, sent: false, restarted: false, noted: false });

/** A bridge with main's own open/close, recording what was closed. */
function bridge() {
  const closed = [];
  return {
    closed,
    incognitoOpen: async () => ({ ok: true, id: M.openIncognitoChat() }),
    incognitoClose: async (id) => { closed.push(id); M.closeIncognitoChat(id); return { ok: true }; },
  };
}

test("an empty new chat offers the toggle; an ordinary chat shows nothing", () => {
  reset();
  assert.match(I.incognitoBarHTML({ sessionId: null, empty: true }, h), /data-incog="on"/);
  assert.equal(I.incognitoBarHTML({ sessionId: "s1", empty: false }, h), "");
  assert.equal(I.incognitoBarHTML({ sessionId: null, empty: false }, h), "");
  assert.equal(I.incognitoSessionForNewChat(), undefined);
  assert.equal(I.incognitoArmed(), false);
});

test("arming fixes the id in main; the first message goes to it and the chat is never a new row", async () => {
  reset();
  const b = bridge();
  assert.equal(await I.incognitoArm(b), true);
  const id = I.INCOG.id;
  assert.match(id, /^incognito-/);
  assert.equal(M.isIncognitoChat(id), true);
  assert.equal(I.incognitoArmed(), true);
  assert.match(I.incognitoBarHTML({ sessionId: null, empty: true }, h), /Turn off/);
  assert.equal(I.incognitoSessionForNewChat(), id);
  assert.equal(I.INCOG.sent, true);
  // From the first message on, the banner stays and there is no way to turn it off.
  const banner = I.incognitoBarHTML({ sessionId: id, empty: false }, h);
  assert.ok(banner.includes(I.INCOG_BANNER));
  assert.doesNotMatch(banner, /Turn off/);
  assert.equal(I.incognitoBarHTML({ sessionId: "other", empty: false }, h), "");
  I.incognitoLeave(b);
});

test("leaving deletes it; reopening the incognito chat itself is no leave", async () => {
  reset();
  const b = bridge();
  await I.incognitoArm(b);
  const id = I.INCOG.id;
  assert.equal(I.incognitoLeave(b, id), false);
  assert.equal(I.INCOG.id, id);
  assert.equal(I.incognitoLeave(b, "another"), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(b.closed, [id]);
  assert.equal(M.isIncognitoChat(id), false);
  assert.equal(I.INCOG.id, null);
  assert.equal(I.incognitoLeave(b), false);
});

test("an agent restart after the first message is said once, in plain words", async () => {
  reset();
  const b = bridge();
  await I.incognitoArm(b);
  // A start before any message lost nothing.
  assert.equal(I.incognitoStatus({ state: "starting" }), "");
  assert.equal(I.incognitoStatus({ state: "connected" }), "");
  I.incognitoSessionForNewChat();
  assert.equal(I.incognitoStatus({ state: "starting" }), "");
  assert.equal(I.incognitoStatus({ state: "connected" }), I.INCOG_RESTART_LINE);
  assert.equal(I.incognitoStatus({ state: "connected" }), "");
  for (const line of [I.INCOG_BANNER, I.INCOG_RESTART_LINE]) assert.ok(!line.includes("—"), line);
  I.incognitoLeave(b);
});

test("main sends incognito with every turn of an open incognito chat, and never for another", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = "t0ken";
  const id = M.openIncognitoChat();
  try {
    await client.chat("t1", [{ role: "user", content: "hi" }], id);
    // An agent restarted between the turns sees the flag again on the next one.
    await client.chat("t2", [{ role: "user", content: "and then?" }], id);
    await client.chat("t3", [{ role: "user", content: "hi" }], "ordinary-chat");
    await client.chat("t4", [{ role: "user", content: "hi" }]);
    const turns = seen.filter((r) => r.url === "/v1/chat/completions").map((r) => JSON.parse(r.body));
    assert.equal(turns[0].incognito, true);
    assert.equal(turns[0].session_id, id);
    assert.equal(turns[1].incognito, true);
    assert.equal("incognito" in turns[2], false);
    assert.equal("incognito" in turns[3], false);
    M.closeIncognitoChat(id);
    await client.chat("t5", [{ role: "user", content: "hi" }], id);
    assert.equal("incognito" in JSON.parse(seen.at(-1).body), false);
  } finally {
    M.closeIncognitoChat(id);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("main's list: open, check, close", () => {
  const id = M.openIncognitoChat();
  assert.deepEqual(M.incognitoBodyField(id), { incognito: true });
  assert.ok(M.openIncognitoChats().includes(id));
  assert.equal(M.closeIncognitoChat(id), true);
  assert.equal(M.closeIncognitoChat(id), false);
  assert.deepEqual(M.incognitoBodyField(id), {});
  assert.deepEqual(M.incognitoBodyField(undefined), {});
});

test("renderer, preload and main use the same names", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /\['eyeOff','New incognito chat','','\/incognito','session:incognito'\]/);
  assert.match(r, /\['incognito','start a new incognito chat: not saved to your chats or memory'\]/);
  assert.match(r, /if \(a === 'session:incognito'\) \{ act\('session:new'\); incognitoArm\(BR\)\.then\(render\); return; \}/);
  assert.match(r, /if \(a === 'session:new'\) \{ close\(\); incognitoLeave\(BR\);/);
  assert.match(r, /const opensChat = !S\.agentSession && !incognitoArmed\(\);/);
  assert.match(r, /const session = S\.agentSession \|\| incognitoSessionForNewChat\(\) \|\| undefined;/);
  assert.match(r, /incognitoLeave\(BR, id\);/);
  assert.match(r, /incognitoBarHTML\(\{sessionId: S\.agentSession, empty: !S\.log\.length\}, \{esc, ic\}\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="incognito-chat.js"') > 0 && html.indexOf('src="incognito-chat.js"') < html.indexOf('src="renderer.js"'));
  assert.match(html, /href="css\/incognito-chat\.css"/);
  const pre = src("../preload/preload.ts");
  assert.match(pre, /incognitoOpen: \(\) => ipcRenderer\.invoke\("incognito:open"\)/);
  assert.match(pre, /incognitoClose: \(id: string\) => ipcRenderer\.invoke\("incognito:close", \{ id \}\)/);
  const ipc = src("../main/incognito-chats-ipc.ts");
  assert.match(ipc, /ipcMain\.handle\("incognito:open"/);
  assert.match(ipc, /ipcMain\.handle\("incognito:close"/);
  assert.match(src("../main/main.ts"), /wireIncognitoChatsIpc\(client\)/);
  assert.match(src("../main/agent-client.ts"), /\.\.\.incognitoBodyField\(sessionId\),/);
  assert.match(src("../main/analytics/catalog-values.ts"), /"incognito"/);
});
