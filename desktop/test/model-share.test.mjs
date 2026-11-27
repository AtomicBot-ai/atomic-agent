// Unit tests for ATO-2483 ("Share this model"): the mDNS announcement
// (main/lan-mdns-announce.ts, main/model-share-announce.ts), the answer
// reading (main/model-share.ts), discovery of a shared model
// (main/lan-discovery.ts), the card (renderer/model-share.js) and the wiring
// read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MD = require("../out/main/lan-mdns.js");
const AN = require("../out/main/lan-mdns-announce.js");
const SA = require("../out/main/model-share-announce.js");
const MS = require("../out/main/model-share.js");
const D = require("../out/main/lan-discovery.js");
const R = require("../renderer/model-share.js");
const F = require("../renderer/lan-find.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const SHARE = { instance: "studio-mac", host: "studio-mac", port: 8787, addresses: ["192.168.1.20"] };

/* ---------- the announcement packets ---------- */

test("the announcement is read back by our own discovery as one service with its address and path", () => {
  const packet = AN.buildShareResponse(SHARE);
  const services = MD.servicesFromRecords(MD.parseMdnsPacket(packet));
  assert.equal(services.length, 1);
  const s = services[0];
  assert.equal(s.instance, "studio-mac");
  assert.equal(s.serviceType, "_atomic-model._tcp.local");
  assert.equal(s.port, 8787);
  assert.equal(s.address, "192.168.1.20");
  assert.ok(s.txt.includes("path=/raw/v1"));
  assert.equal(D.advertisedRootPath(s.serviceType, s.txt), "/raw");
});

test("the announcement never carries a key or a model name, and a goodbye has TTL 0", () => {
  const hello = AN.buildShareResponse(SHARE);
  const packet = AN.buildShareResponse(SHARE, { ttl: 0 });
  assert.ok(!/key=|sk-|model=/.test(hello.toString("latin1")));
  // The TTL of 120 s is in the announcement and in no record of the goodbye.
  const ttl120 = Buffer.from([0, 0, 0, 120]);
  assert.ok(hello.includes(ttl120));
  assert.ok(!packet.includes(ttl120));
  assert.equal(packet.length, hello.length);
  assert.equal(packet.readUInt16BE(2), 0x8400); // an authoritative answer
});

test("queries are matched: our type, our instance, the services meta-query; others are ignored", () => {
  const ask = (name, type = 12) => MD.parseMdnsQuestions(Buffer.from(MD.buildMdnsQuery([name])).fill(0, 0, 2)).map((q) => ({ ...q, type }));
  assert.equal(AN.matchShareQuery(ask("_atomic-model._tcp.local"), SHARE), "share");
  assert.equal(AN.matchShareQuery(ask("studio-mac._atomic-model._tcp.local", 33), SHARE), "share");
  assert.equal(AN.matchShareQuery(ask("_services._dns-sd._udp.local"), SHARE), "services");
  assert.equal(AN.matchShareQuery(ask("_ollama._tcp.local"), SHARE), null);
  // Our own discovery's query (several types at once) gets an answer too.
  assert.equal(AN.matchShareQuery(MD.parseMdnsQuestions(MD.buildMdnsQuery()), SHARE), "share");
});

test("a response packet has no questions, so the responder never answers an answer", () => {
  assert.deepEqual(MD.parseMdnsQuestions(AN.buildShareResponse(SHARE)), []);
  assert.deepEqual(MD.parseMdnsQuestions(Buffer.from([1, 2, 3])), []);
});

test("the instance label is a DNS label made from the computer's name", () => {
  assert.equal(AN.instanceLabel("Nadyas-MacBook-Pro.local"), "Nadyas-MacBook-Pro");
  assert.equal(AN.instanceLabel("DESKTOP 7Q!X"), "DESKTOP-7Q-X");
  assert.equal(AN.instanceLabel(""), "atomic-agent");
  assert.ok(AN.instanceLabel("x".repeat(200)).length <= 63);
});

/* ---------- the responder, on a fake socket ---------- */

function fakeSocket() {
  const s = new EventEmitter();
  s.sent = [];
  s.closed = false;
  s.memberships = [];
  s.bind = (_port, cb) => setImmediate(cb);
  s.setMulticastTTL = () => {};
  s.addMembership = (group, iface) => s.memberships.push([group, iface]);
  s.send = (packet, port, address, cb) => { s.sent.push({ packet, port, address }); if (cb) setImmediate(cb); };
  s.close = () => { s.closed = true; };
  return s;
}

const IFACES = { en0: [{ family: "IPv4", address: "192.168.1.20", netmask: "255.255.255.0", internal: false }] };

test("the responder announces on start, answers a one-shot query by unicast, and says goodbye on stop", async () => {
  const sock = fakeSocket();
  const a = SA.createShareAnnouncer({ createSocket: () => sock, interfaces: () => IFACES, hostname: () => "studio-mac", say: () => {} });
  a.set(8787);
  await new Promise((r) => setImmediate(r));
  assert.ok(a.active());
  assert.deepEqual(sock.memberships, [["224.0.0.251", "192.168.1.20"]]);
  assert.equal(sock.sent[0].address, "224.0.0.251");

  sock.emit("message", MD.buildMdnsQuery(), { address: "192.168.1.30", port: 53001 });
  const reply = sock.sent.at(-1);
  assert.equal(reply.address, "192.168.1.30");
  assert.equal(reply.port, 53001);
  assert.equal(MD.servicesFromRecords(MD.parseMdnsPacket(reply.packet))[0].port, 8787);

  a.stop();
  await new Promise((r) => setImmediate(r));
  const goodbye = sock.sent.at(-1);
  assert.equal(goodbye.address, "224.0.0.251");
  assert.ok(!goodbye.packet.includes(Buffer.from([0, 0, 0, 120])), "a goodbye has TTL 0");
  assert.ok(sock.closed);
  assert.equal(a.active(), false);
});

test("nothing is sent before the socket is bound, and no private network means no socket", () => {
  const sock = fakeSocket();
  sock.bind = () => {}; // never binds
  const a = SA.createShareAnnouncer({ createSocket: () => sock, interfaces: () => IFACES, hostname: () => "h", say: () => {} });
  a.set(8787);
  a.set(9000);
  assert.deepEqual(sock.sent, []);
  let made = 0;
  const b = SA.createShareAnnouncer({ createSocket: () => (made++, fakeSocket()), interfaces: () => ({}), hostname: () => "h", say: () => {} });
  b.set(8787);
  assert.equal(made, 0);
});

/* ---------- the agent's answer ---------- */

const ANSWER = {
  mode: "network", port: 8787, key: "k".repeat(64),
  urls: { local: "http://127.0.0.1:8787/raw/v1", lan: ["http://192.168.1.20:8787/raw/v1"] },
  listener: { state: "listening", host: "0.0.0.0", port: 8787 },
};

test("the answer is read into a view; junk is not a view", () => {
  const v = MS.readShareAnswer(ANSWER);
  assert.equal(v.mode, "network");
  assert.equal(v.key, "k".repeat(64));
  assert.deepEqual(v.lan, ["http://192.168.1.20:8787/raw/v1"]);
  assert.equal(MS.readShareAnswer({ mode: "everywhere" }), null);
  assert.equal(MS.readShareAnswer(null), null);
  assert.equal(MS.readShareAnswer({ ...ANSWER, mode: "off" }).key, null);
});

test("only a model listening on the network is announced", () => {
  assert.equal(MS.announcePortOf(MS.readShareAnswer(ANSWER)), 8787);
  assert.equal(MS.announcePortOf(MS.readShareAnswer({ ...ANSWER, mode: "local", listener: { state: "listening", host: "127.0.0.1", port: 8787 } })), null);
  assert.equal(MS.announcePortOf(MS.readShareAnswer({ ...ANSWER, listener: { state: "failed", host: "0.0.0.0", port: 8787, problem: "port-busy" } })), null);
  assert.equal(MS.announcePortOf(MS.readShareAnswer({ ...ANSWER, listener: { state: "main", port: 8787, network: false } })), null);
  assert.equal(MS.announcePortOf(MS.readShareAnswer({ ...ANSWER, mode: "off", listener: { state: "off" } })), null);
});

/* ---------- discovery of another computer's shared model ---------- */

test("a /raw root that answers like a model server is a shared model, not the agent", () => {
  assert.equal(D.sharedModelKind("http://192.168.1.20:8787/raw", "atomic-agent"), "atomic-agent-model");
  assert.equal(D.sharedModelKind("http://192.168.1.20:8787", "atomic-agent"), "atomic-agent");
  assert.equal(D.KIND_WORDS["atomic-agent-model"], "Atomic Agent shared model");
  assert.equal(D.advertisedRootPath("_http._tcp.local", ["path=/raw/v1"]), "");
  assert.equal(D.advertisedRootPath("_atomic-model._tcp.local", ["path=/etc"]), "");
});

test("a found shared model can be picked, and says where its key is", () => {
  const row = F.lanfServerView({ host: "192.168.1.20", name: "studio-mac", kind: "atomic-agent-model", kindWord: "Atomic Agent shared model", url: "http://192.168.1.20:8787/raw", latencyMs: 4, needsKey: true, models: [] });
  assert.equal(row.usable, true);
  assert.match(row.note, /Share this model/);
  assert.equal(F.lanfFillUrl("wiz-url", "http://192.168.1.20:8787/raw"), "http://192.168.1.20:8787/raw/v1");
  assert.match(F.lanfCheckView({ ok: true, kind: "atomic-agent-model", kindWord: "Atomic Agent shared model", latencyMs: 4, needsKey: true, models: [] }).text, /API key/);
});

/* ---------- the card ---------- */

const H = { esc: (s) => String(s), isWin: false };
const view = (patch = {}) => ({ ...MS.readShareAnswer(ANSWER), ...patch });
const st = (patch = {}) => ({ view: view(), supported: true, busy: false, error: null, detail: null, note: null, showKey: false, rotateAsk: false, ...patch });

test("the card offers the three choices and, when on, the addresses and a hidden key", () => {
  const html = R.mshCardHTML(st(), H);
  for (const m of ["off", "local", "network"]) assert.match(html, new RegExp(`data-msh-mode="${m}"`));
  assert.match(html, /http:\/\/127\.0\.0\.1:8787\/raw\/v1/);
  assert.match(html, /http:\/\/192\.168\.1\.20:8787\/raw\/v1/);
  assert.ok(!html.includes("k".repeat(64)), "the key is masked until Show");
  assert.match(html, /kkkk/);
  assert.match(R.mshCardHTML(st({ showKey: true }), H), new RegExp("k".repeat(64)));
});

test("the network choice warns about plain http; this computer only does not", () => {
  assert.match(R.mshCardHTML(st(), H), /Plain http/);
  const local = view({ mode: "local", lan: [], listener: { state: "listening", host: "127.0.0.1", port: 8787 } });
  assert.ok(!/Plain http/.test(R.mshCardHTML(st({ view: local }), H)));
  assert.match(R.mshCardHTML(st(), { ...H, isWin: true }), /firewall/);
});

test("off shows no address and no key; loading and a failed read keep the card's shape", () => {
  const off = R.mshCardHTML(st({ view: view({ mode: "off", key: null, lan: [], listener: { state: "off" } }) }), H);
  assert.ok(!/raw\/v1/.test(off));
  assert.match(R.mshCardHTML(st({ view: null }), H), /Checking whether this model is shared/);
  const failed = R.mshCardHTML(st({ view: null, error: "The sharing setting could not be read. Try again in a moment.", detail: "ECONNREFUSED" }), H);
  assert.match(failed, /data-msh="retry"/);
  assert.match(failed, /<summary>Details<\/summary>/);
  assert.equal(R.mshCardHTML(st({ supported: false }), H), "");
});

test("a busy port and a loopback-only agent are told in plain words", () => {
  const busy = view({ listener: { state: "failed", host: "0.0.0.0", port: 8787, problem: "port-busy" } });
  assert.match(R.mshProblemWords(busy, false), /Port 8787 is already used/);
  assert.equal(R.mshListening(busy), false);
  assert.ok(!/raw\/v1/.test(R.mshCardHTML(st({ view: busy }), H)), "no address to copy while nothing listens");
  assert.match(R.mshProblemWords(view({ listener: { state: "main", port: 8787, network: false } }), false), /this computer only/);
  assert.equal(R.mshProblemWords(view(), false), "");
});

test("a new key is asked for twice, and Copy copies the value it names", () => {
  assert.match(R.mshCardHTML(st(), H), /data-msh="rotate"/);
  assert.match(R.mshCardHTML(st({ rotateAsk: true }), H), /data-msh="rotate-yes"/);
  R.MSH.view = view();
  assert.equal(R.mshCopyValue("key"), "k".repeat(64));
  assert.equal(R.mshCopyValue("lan:0"), "http://192.168.1.20:8787/raw/v1");
  assert.equal(R.mshCopyValue("local"), "http://127.0.0.1:8787/raw/v1");
  assert.equal(R.mshCopyValue("lan:9"), "");
});

/* ---------- wiring ---------- */

test("the routes are wired, exposed and drawn on Settings › Models", () => {
  assert.match(src("../main/main.ts"), /wireModelShareIpc\(\{ client \}\)/);
  const pre = src("../preload/preload.ts");
  assert.match(pre, /modelShare: \(\) => ipcRenderer\.invoke\("modelShare:get"\)/);
  assert.match(pre, /modelShareSet: .*ipcRenderer\.invoke\("modelShare:set"/);
  const ipc = src("../main/model-share-ipc.ts");
  assert.match(ipc, /ipcMain\.handle\("modelShare:get"/);
  assert.match(ipc, /ipcMain\.handle\("modelShare:set"/);
  assert.ok(!/console\.(log|error)\([^)]*key/i.test(ipc), "the key is never logged");
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="model-share.js"') > 0 && html.indexOf('src="model-share.js"') < html.indexOf('src="renderer.js"'));
  assert.match(html, /css\/model-share\.css/);
  assert.match(src("../renderer/renderer.js"), /modelShareHTML\(\)/);
  assert.match(src("../main/agent-client.ts"), /\/api\/model-share/);
});
