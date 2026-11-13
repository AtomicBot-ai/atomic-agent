// Unit tests for ATO-1067 ("Find on my network" and "Check connection"):
// main/lan-mdns.ts and main/lan-discovery.ts (against the built output), the
// pure half of renderer/lan-find.js, and the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MD = require("../out/main/lan-mdns.js");
const D = require("../out/main/lan-discovery.js");
const R = require("../renderer/lan-find.js");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- mDNS packets ---------- */

const name = (n) => Buffer.concat([...n.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const rr = (nameBytes, type, rdata) => Buffer.concat([nameBytes, u16(type), u16(1), Buffer.from([0, 0, 0, 120]), u16(rdata.length), rdata]);

test("the query asks one PTR question per service type, with the unicast-response bit", () => {
  const q = MD.buildMdnsQuery(["_http._tcp.local", "_ollama._tcp.local"], 0);
  assert.equal(q.readUInt16BE(0), 0); // id
  assert.equal(q.readUInt16BE(2), 0); // a query
  assert.equal(q.readUInt16BE(4), 2); // two questions
  assert.equal(q.readUInt16BE(6) + q.readUInt16BE(8) + q.readUInt16BE(10), 0);
  const first = name("_http._tcp.local");
  assert.deepEqual(q.subarray(12, 12 + first.length), first);
  assert.equal(q.readUInt16BE(12 + first.length), 12); // PTR
  assert.equal(q.readUInt16BE(14 + first.length), 0x8001); // QU + IN
  assert.equal(q.length, 12 + first.length + 4 + name("_ollama._tcp.local").length + 4);
});

test("the default query covers the generic and the LLM service types", () => {
  assert.ok(MD.MDNS_SERVICE_TYPES.includes("_http._tcp.local"));
  assert.ok(MD.MDNS_SERVICE_TYPES.includes("_ollama._tcp.local"));
  const q = MD.buildMdnsQuery();
  assert.equal(q.readUInt16BE(4), MD.MDNS_SERVICE_TYPES.length);
});

/** A response: PTR _ollama._tcp.local → gpu._ollama._tcp.local, SRV → gpu-box.local:11434, TXT, A 192.168.1.42; names after the first use pointers. */
function response() {
  const header = Buffer.from([0, 0, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 3]);
  const svcName = name("_ollama._tcp.local"); // at offset 12
  const ptrTarget = Buffer.concat([Buffer.from([3]), Buffer.from("gpu"), Buffer.from([0xc0, 12])]); // gpu.<ptr to _ollama._tcp.local>
  const answer = rr(svcName, 12, ptrTarget);
  const instOffset = 12 + svcName.length + 10; // where "gpu..." starts in the PTR rdata
  const instPtr = Buffer.from([0xc0, instOffset]);
  const srvTarget = name("gpu-box.local");
  const srv = rr(instPtr, 33, Buffer.concat([u16(0), u16(0), u16(11434), srvTarget]));
  const txt = rr(instPtr, 16, Buffer.concat([Buffer.from([9]), Buffer.from("model=qwe"), Buffer.from([0])]));
  const a = rr(name("gpu-box.local"), 1, Buffer.from([192, 168, 1, 42]));
  return Buffer.concat([header, answer, srv, txt, a]);
}

test("a response is read, compression pointers and all", () => {
  const recs = MD.parseMdnsPacket(response());
  assert.deepEqual(recs.map((r) => r.type), ["PTR", "SRV", "TXT", "A"]);
  assert.equal(recs[0].name, "_ollama._tcp.local");
  assert.equal(recs[0].target, "gpu._ollama._tcp.local");
  assert.equal(recs[1].name, "gpu._ollama._tcp.local");
  assert.equal(recs[1].port, 11434);
  assert.equal(recs[1].target, "gpu-box.local");
  assert.deepEqual(recs[2].entries, ["model=qwe"]);
  assert.equal(recs[3].address, "192.168.1.42");
});

test("the records come together as one service with its address", () => {
  const services = MD.servicesFromRecords(MD.parseMdnsPacket(response()));
  assert.deepEqual(services, [{
    instance: "gpu", serviceType: "_ollama._tcp.local", host: "gpu-box.local", port: 11434, address: "192.168.1.42", txt: ["model=qwe"],
  }]);
});

test("a PTR without its SRV, or for a type we did not ask for, is no service", () => {
  const recs = [
    { name: "_ollama._tcp.local", type: "PTR", target: "a._ollama._tcp.local" },
    { name: "_printer._tcp.local", type: "PTR", target: "p._printer._tcp.local" },
    { name: "p._printer._tcp.local", type: "SRV", port: 631, target: "printer.local" },
  ];
  assert.deepEqual(MD.servicesFromRecords(recs), []);
});

test("queries, short packets, garbage and pointer loops give no records and never throw", () => {
  assert.deepEqual(MD.parseMdnsPacket(MD.buildMdnsQuery()), []);
  assert.deepEqual(MD.parseMdnsPacket(Buffer.from([1, 2, 3])), []);
  assert.deepEqual(MD.parseMdnsPacket(Buffer.alloc(0)), []);
  const loop = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0xc0, 12])]);
  assert.deepEqual(MD.parseMdnsPacket(loop), []);
  const cut = response().subarray(0, 40);
  assert.ok(Array.isArray(MD.parseMdnsPacket(cut)));
});

/* ---------- which addresses are probed ---------- */

test("only RFC 1918 addresses count as private", () => {
  for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) assert.equal(D.isPrivateV4(ip), true, ip);
  for (const ip of ["127.0.0.1", "169.254.1.1", "100.64.0.1", "172.32.0.1", "8.8.8.8", "192.169.0.1", "1.2.3", "a.b.c.d", ""]) assert.equal(D.isPrivateV4(ip), false, ip);
});

test("subnets: the /24 around each private address, narrower masks kept, virtual and public ones skipped", () => {
  const ifaces = {
    lo0: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
    en0: [
      { family: "IPv4", address: "192.168.1.23", netmask: "255.255.0.0", internal: false },
      { family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", internal: false },
    ],
    docker0: [{ family: "IPv4", address: "172.17.0.1", netmask: "255.255.0.0", internal: false }],
    utun3: [{ family: "IPv4", address: "100.101.1.2", netmask: "255.255.255.255", internal: false }],
    en5: [{ family: 4, address: "10.0.0.130", netmask: "255.255.255.128", internal: false }],
  };
  assert.deepEqual(D.subnetsFromInterfaces(ifaces), [
    { self: "192.168.1.23", prefix: "192.168.1", from: 1, to: 254 },
    { self: "10.0.0.130", prefix: "10.0.0", from: 129, to: 254 },
  ]);
});

test("subnets stop at MAX_SUBNETS and list each /24 once", () => {
  const many = {};
  for (let i = 0; i < 5; i++) many[`en${i}`] = [{ family: "IPv4", address: `192.168.${i}.2`, netmask: "255.255.255.0", internal: false }];
  many.en9 = [{ family: "IPv4", address: "192.168.0.9", netmask: "255.255.255.0", internal: false }];
  const out = D.subnetsFromInterfaces(many);
  assert.equal(out.length, D.MAX_SUBNETS);
  assert.equal(new Set(out.map((s) => s.prefix)).size, out.length);
  assert.deepEqual(D.subnetsFromInterfaces({}), []);
  assert.deepEqual(D.subnetsFromInterfaces({ en0: [{ family: "IPv4", address: "192.168.1.2", netmask: "255.255.255.254", internal: false }] }), []);
});

test("the hosts probed skip our own address and stay inside the subnet", () => {
  const hosts = D.hostsToProbe([{ self: "192.168.1.23", prefix: "192.168.1", from: 1, to: 254 }]);
  assert.equal(hosts.length, 253);
  assert.ok(!hosts.includes("192.168.1.23"));
  assert.equal(hosts[0], "192.168.1.1");
  assert.equal(hosts.at(-1), "192.168.1.254");
  assert.ok(hosts.every((h) => D.isPrivateV4(h)));
});

test("the known ports are the servers' defaults", () => {
  const ports = Object.fromEntries(D.KNOWN_PORTS.map((k) => [k.kind, k.port]));
  assert.equal(ports["llama.cpp"], 8080);
  assert.equal(ports.ollama, 11434);
  assert.equal(ports.lmstudio, 1234);
  assert.equal(ports["atomic-agent"], 8787);
  assert.ok(D.CONNECT_TIMEOUT_MS <= 1000 && D.PROBE_CONCURRENCY <= 128);
});

/* ---------- the check ---------- */

test("an address is read the way people type it", () => {
  assert.equal(D.normalizeCheckUrl("192.168.1.5:8080"), "http://192.168.1.5:8080");
  assert.equal(D.normalizeCheckUrl(" http://gpu-box.local:11434/ "), "http://gpu-box.local:11434");
  assert.equal(D.normalizeCheckUrl("http://10.0.0.2:1234/v1"), "http://10.0.0.2:1234");
  assert.equal(D.normalizeCheckUrl("https://host/api/v1/"), "https://host/api");
  assert.equal(D.normalizeCheckUrl("ftp://host"), null);
  assert.equal(D.normalizeCheckUrl("http://user:pw@host"), null);
  assert.equal(D.normalizeCheckUrl(""), null);
  assert.equal(D.normalizeCheckUrl(undefined), null);
});

const ok = (json) => ({ status: 200, json });
const none = { status: 404, json: null };

test("Ollama is told by /api/tags, with its model names", () => {
  const c = D.classifyServer(ok({ object: "list", data: [{ id: "llama3", owned_by: "library" }] }), ok({ models: [{ name: "llama3:8b" }, { name: "qwen3:4b" }] }), 11434);
  assert.deepEqual(c, { ok: true, kind: "ollama", models: ["llama3:8b", "qwen3:4b"], needsKey: false });
});

test("llama-server and our agent are told by owned_by, whatever the port", () => {
  assert.equal(D.classifyServer(ok({ data: [{ id: "m.gguf", owned_by: "llamacpp" }] }), none, 9000).kind, "llama.cpp");
  assert.equal(D.classifyServer(ok({ data: [{ id: "atomic", owned_by: "atomic-agent" }] }), none, 8787).kind, "atomic-agent");
});

test("past owned_by, the port decides, but never calls an unknown server llama.cpp or the agent", () => {
  assert.equal(D.classifyServer(ok({ data: [{ id: "qwen", owned_by: "organization_owner" }] }), none, 1234).kind, "lmstudio");
  assert.equal(D.classifyServer(ok({ data: [{ id: "x" }] }), none, 8080).kind, "openai-compatible");
  assert.equal(D.classifyServer(ok({ data: [{ id: "x" }] }), none, 8787).kind, "openai-compatible");
  assert.deepEqual(D.classifyServer(ok({ data: [{ id: "a" }, { id: "a" }, { id: 3 }, null] }), none, 5000).models, ["a"]);
});

test("a 401 is a server that asks for a key; a web page is not a model server", () => {
  assert.deepEqual(D.classifyServer({ status: 401, json: null }, { status: 401, json: null }, 8080), { ok: true, kind: "llama.cpp", models: [], needsKey: true });
  assert.deepEqual(D.classifyServer(ok({ hello: "router" }), none, 8080), { ok: false, reason: "not-a-model-server" });
  assert.deepEqual(D.classifyServer(none, none, 80), { ok: false, reason: "not-a-model-server" });
});

test("network errors become plain reasons, each with its own words", () => {
  assert.deepEqual(D.classifyServer({ error: "ECONNREFUSED" }, { error: "ECONNREFUSED" }, 8080), { ok: false, reason: "refused" });
  assert.equal(D.errorReason("TimeoutError"), "timeout");
  assert.equal(D.errorReason("UND_ERR_CONNECT_TIMEOUT"), "timeout");
  assert.equal(D.errorReason("ENOTFOUND"), "dns");
  assert.equal(D.errorReason("EHOSTUNREACH"), "unreachable");
  assert.equal(D.errorReason("weird"), "failed");
  assert.equal(D.errorReason(undefined), "failed");
  const reasons = ["bad-url", "refused", "timeout", "dns", "unreachable", "not-a-model-server", "failed"];
  const words = reasons.map((r) => D.failureWords(r));
  assert.equal(new Set(words).size, reasons.length);
  assert.match(D.failureWords("refused"), /127\.0\.0\.1/);
});

test("mapLimit keeps the order and never runs more than the limit at once", async () => {
  let live = 0, peak = 0;
  const out = await D.mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, n));
    live--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
  assert.ok(peak <= 3);
  assert.deepEqual(await D.mapLimit([], 4, async () => 1), []);
});

/* ---------- the renderer's pure half ---------- */

test("a found address goes into the field in the field's own shape", () => {
  assert.equal(R.lanfFillUrl("llm-url", "http://192.168.1.42:8080"), "http://192.168.1.42:8080");
  assert.equal(R.lanfFillUrl("wiz-url", "http://192.168.1.42:11434/"), "http://192.168.1.42:11434/v1");
});

test("the models line names three and counts the rest", () => {
  assert.equal(R.lanfModelsWord([]), "no models listed");
  assert.equal(R.lanfModelsWord(["a", "b"]), "a, b");
  assert.equal(R.lanfModelsWord(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");
});

const server = (over) => ({ url: "http://192.168.1.42:11434", host: "192.168.1.42", name: null, via: "scan", kind: "ollama", kindWord: "Ollama", models: ["llama3:8b"], needsKey: false, latencyMs: 12, ...over });

test("a found server is a row to click, an agent is listed but not offered", () => {
  const v = R.lanfServerView(server({ name: "gpu" }));
  assert.equal(v.usable, true);
  assert.match(v.title, /gpu \(192\.168\.1\.42\).*Ollama/);
  assert.match(v.sub, /12 ms/);
  const agent = R.lanfServerView(server({ kind: "atomic-agent", kindWord: "Atomic Agent" }));
  assert.equal(agent.usable, false);
  assert.match(agent.note, /Connect to Another Computer/);
});

test("the check says what answered, or why not", () => {
  assert.equal(R.lanfCheckView({ ok: true, ...server() }).tone, "ok");
  assert.equal(R.lanfCheckView({ ok: true, ...server({ models: [] }) }).tone, "warn");
  assert.equal(R.lanfCheckView({ ok: true, ...server({ needsKey: true }) }).tone, "warn");
  assert.deepEqual(R.lanfCheckView({ ok: false, error: "No answer in time." }), { tone: "bad", text: "No answer in time." });
  assert.equal(R.lanfCheckView(null).tone, "bad");
});

test("the search line says where it looked and how to make a server visible", () => {
  assert.equal(R.lanfFindLine({ state: "idle", servers: [], networks: [] }), "");
  assert.match(R.lanfFindLine({ state: "finding", servers: [], networks: [] }), /15 seconds/);
  assert.match(R.lanfFindLine({ state: "done", servers: [], networks: [] }), /not on a home or office network/);
  const none = R.lanfFindLine({ state: "done", servers: [], networks: ["192.168.1.0/24"] });
  assert.match(none, /192\.168\.1\.0\/24/);
  assert.match(none, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("the panel escapes what a server says about itself", () => {
  R.LANF.state = "done";
  R.LANF.networks = ["192.168.1.0/24"];
  R.LANF.servers = [server({ name: "<img src=x>", models: ["<b>m</b>"] })];
  const html = R.lanfHTML("llm-url");
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<b>m"));
  assert.match(html, /data-lanf-for="llm-url"/);
  assert.match(html, /data-lanf-use="http:\/\/192\.168\.1\.42:11434"/);
  R.LANF.state = "idle"; R.LANF.servers = []; R.LANF.networks = [];
});

/* ---------- wiring ---------- */

test("the routes are wired, exposed and drawn under both address fields", () => {
  assert.match(src("../main/main.ts"), /wireLanDiscoveryIpc\(\)/);
  const pre = src("../preload/preload.ts");
  assert.match(pre, /lanFind: \(\) => ipcRenderer\.invoke\("lan:find"\)/);
  assert.match(pre, /lanCheck: \(url: string\) => ipcRenderer\.invoke\("lan:check", url\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="lan-find.js"') > 0 && html.indexOf('src="lan-find.js"') < html.indexOf('src="renderer.js"'));
  assert.match(html, /css\/lan-find\.css/);
  const r = src("../renderer/renderer.js");
  assert.match(r, /lanfHTML\('llm-url'\)/);
  assert.match(r, /lanfHTML\('wiz-url'\)/);
});

test("the check only reads: GET requests, never a chat completion", () => {
  const ipc = src("../main/lan-discovery-ipc.ts");
  assert.ok(!/chat\/completions|method: "POST"/.test(ipc));
  assert.match(ipc, /\/v1\/models/);
  assert.match(ipc, /\/api\/tags/);
});

test("the mac build declares the Local Network prompt text and every browsed service type", () => {
  const cfg = require("../electron-builder.cjs");
  const info = cfg.mac.extendInfo;
  assert.equal(typeof info.NSLocalNetworkUsageDescription, "string");
  assert.ok(info.NSLocalNetworkUsageDescription.length > 20);
  const declared = new Set(info.NSBonjourServices);
  for (const type of MD.MDNS_SERVICE_TYPES) assert.ok(declared.has(type.replace(/\.local$/, "")), type);
});
