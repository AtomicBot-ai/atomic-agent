// Unit tests for main/import-facts.ts (ATO-1629 / ATO-1061) and the
// import_facts event, against the built output. Run: npm run build && npm run test:unit
//
// The window's "Here is what I learned about you" step reaches the agent's
// /api/import/facts/* only through these handlers: the start body (local by
// default, cloud only with this run's tick), the job view the window polls,
// the save that sends only ids the job listed, and the refusal of an agent
// on another computer, which could not open a file on this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../out/main/import-facts.js");
const V = require("../out/main/analytics/validate.js");

const rawJob = (over = {}) => ({
  id: "job-1",
  source: "claude",
  state: "extracting",
  providerId: "local-llama",
  local: true,
  progress: { chunksDone: 2, chunksTotal: 5, candidates: 3 },
  stats: null,
  failedChunks: 0,
  dropped: { ungrounded: 0, sensitive: 0, duplicate: 0 },
  candidates: null,
  error: null,
  ...over,
});
const cand = (id, over = {}) => ({ id, kind: "profile", key: "work_role", value: "Product owner", pinned: false, chatId: "c1", quote: "I run the product", ...over });
// The paths here do not exist: every export looks like a small real .zip to the start check (ATO-1656,
// test/import-facts-input.test.mjs drives the real file system).
const zipStat = () => ({ isFile: () => true, isDirectory: () => false, size: 4096 });

function fakeClient(over = {}) {
  const calls = [];
  const answers = over.answers || {};
  return {
    calls,
    status: { state: "connected" },
    isRemote: false,
    capabilities: async () => ({ agent: { questions: true, importFacts: true } }),
    config: async () => ({ llm: { activeTextProvider: "local-llama", providers: [] } }),
    importFactsRoute: async (method, path, body) => {
      calls.push({ method, path, body });
      const a = answers[method + " " + path];
      if (typeof a === "function") return a(body);
      return a || { status: 200, body: null };
    },
    ...over,
  };
}

test("the step is offered only when the agent's capabilities say importFacts under agent", () => {
  assert.equal(F.importFactsSupported({ agent: { questions: true, importFacts: true } }), true);
  assert.equal(F.importFactsSupported({ agent: { questions: true } }), false);
  assert.equal(F.importFactsSupported({ importFacts: true }), false);
  assert.equal(F.importFactsSupported(null), false);
});

test("the start body reads with the local model unless this run's box is ticked", () => {
  const local = F.factsStartBody({ source: "claude", path: "/Users/me/export.zip" }, zipStat);
  assert.deepEqual(local, { ok: true, local: true, body: { source: "claude", path: "/Users/me/export.zip", engine: { kind: "local" } } });
  const cloud = F.factsStartBody({ source: "chatgpt", path: "/Users/me/c.zip", cloud: { provider: "openrouter", consent: true } }, zipStat);
  assert.deepEqual(cloud.body.engine, { kind: "cloud", provider: "openrouter", cloudConsent: true });
  assert.equal(cloud.local, false);
  // No tick, no cloud: anything but a literal true is refused before the agent is asked.
  for (const consent of [false, "true", 1, undefined]) {
    assert.equal(F.factsStartBody({ source: "claude", path: "/x.zip", cloud: { provider: "openrouter", consent } }, zipStat).ok, false);
  }
  assert.equal(F.factsStartBody({ source: "claude", path: "export.zip" }, zipStat).ok, false, "a relative path");
  assert.equal(F.factsStartBody({ source: "gemini", path: "/x.zip" }, zipStat).ok, false);
  assert.equal(F.factsStartBody({ source: "claude", path: "/x.zip", cloud: { consent: true } }, zipStat).ok, false, "no provider");
  // ATO-1656: the path is looked up; without a stat of its own the real file system answers, and /Users/me/export.zip is not there.
  const gone = F.factsStartBody({ source: "claude", path: "/Users/me/export.zip" });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /not there any more/);
});

test("a job view is parsed from {job}, progress clamped, candidates cleaned", () => {
  const j = F.parseFactsJob({ job: rawJob() });
  assert.equal(j.id, "job-1");
  assert.equal(j.state, "extracting");
  assert.equal(j.chunksDone, 2);
  assert.equal(j.chunksTotal, 5);
  assert.equal(j.found, 3);
  assert.equal(j.candidates, null);
  assert.equal(j.local, true);
  const over = F.parseFactsJob({ job: rawJob({ progress: { chunksDone: 9, chunksTotal: 5 } }) });
  assert.equal(over.chunksDone, 5);
  const done = F.parseFactsJob({
    job: rawJob({
      state: "done",
      candidates: [cand("c0-1"), cand("c0-2", { kind: "note", key: "ignored", value: "  Likes tea  " }), { id: "", value: "x" }, { id: "c0-3", value: "   " }, null],
    }),
  });
  assert.equal(done.candidates.length, 2);
  assert.deepEqual(done.candidates[1], { id: "c0-2", kind: "note", key: null, value: "Likes tea", pinned: false, quote: "I run the product" });
  assert.equal(done.found, 2);
  assert.equal("chatId" in done.candidates[0], false, "the window gets no chat ids");
  assert.equal(F.parseFactsJob({ job: rawJob({ state: "weird" }) }), null);
  assert.equal(F.parseFactsJob({ job: { state: "done" } }), null);
  assert.equal(F.parseFactsJob(null), null);
});

test("the save answer keeps counts only", () => {
  assert.deepEqual(F.parseFactsSave({ saved: 3, skipped: 2, conflicts: [{ key: "name", reason: "differs" }], failed: 0, receiptId: "r1" }),
    { saved: 3, skipped: 2, conflicts: 1, failed: 0, receiptId: "r1" });
  assert.equal(F.parseFactsSave({ skipped: 1 }), null);
});

test("the agent's error codes read as plain words; an agent without the routes reads as too old", () => {
  const e = (status, code, message = "x") => F.factsErrorText(status, { error: { message, type: "invalid_request_error", param: null, code } });
  assert.match(e(403, "cloud_consent_required"), /Tick the box/);
  assert.match(e(422, "no_local_model"), /No local model/);
  assert.match(e(422, "unknown_provider"), /not set up/);
  assert.match(e(422, "not_cloud"), /runs on this computer/);
  assert.match(e(409, "busy"), /already reading/);
  assert.match(F.factsErrorText(404, { error: { message: "no route" } }), /Update Atomic Agent/);
  assert.match(e(400, undefined, "path must be absolute"), /path must be absolute/);
  assert.match(F.factsErrorText(500, null), /HTTP 500/);
});

test("the cloud choices leave out local and network models and put the active one first", () => {
  const choices = F.cloudChoices({
    llm: {
      activeTextProvider: "anthropic",
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://192.168.1.20:1234/v1" },
        { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
        { id: "anthropic", kind: "anthropic" },
        { id: "mine", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", label: "My proxy" },
      ],
    },
  });
  assert.deepEqual(choices, [
    { id: "anthropic", label: "Anthropic" },
    { id: "openrouter", label: "OpenRouter" },
    { id: "mine", label: "My proxy" },
  ]);
  assert.deepEqual(F.cloudChoices(null), []);
});

test("an agent on another computer is refused before anything is sent", async () => {
  const client = fakeClient({ isRemote: true });
  const h = F.createImportFactsHandlers({ client, stat: zipStat });
  const started = await h.start({ source: "claude", path: "/Users/me/export.zip" });
  assert.equal(started.ok, false);
  assert.equal(started.remote, true);
  assert.equal(started.error, F.FACTS_REMOTE_TEXT);
  assert.deepEqual(client.calls, [], "the agent was not asked");
  const info = await h.info();
  assert.deepEqual(info, { ok: true, supported: false, remote: true, cloud: [] });
  const polled = await h.job("job-1");
  assert.equal(polled.remote, true);
  assert.deepEqual(client.calls, []);
});

test("a stopped agent is refused with its own words, not a network error", async () => {
  const client = fakeClient({ status: { state: "stopped" } });
  const h = F.createImportFactsHandlers({ client, stat: zipStat });
  const r = await h.start({ source: "claude", path: "/x.zip" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not running/);
  assert.deepEqual(client.calls, []);
});

test("start, poll until done, then save only ticked ids the job listed", async () => {
  const found = [];
  const saved = [];
  let polls = 0;
  const client = fakeClient({
    answers: {
      "POST start": { status: 200, body: { job: rawJob({ state: "reading", progress: { chunksDone: 0, chunksTotal: 0, candidates: 0 } }) } },
      "GET jobs/job-1": () => {
        polls += 1;
        return polls < 2
          ? { status: 200, body: { job: rawJob() } }
          : { status: 200, body: { job: rawJob({ state: "done", candidates: [cand("c0-1"), cand("c0-2")] }) } };
      },
      "POST jobs/job-1/save": { status: 200, body: { saved: 1, skipped: 1, conflicts: [], failed: 0, receiptId: "r9" } },
    },
  });
  const h = F.createImportFactsHandlers({ client, stat: zipStat, onFound: (i) => found.push(i), onSaved: (i) => saved.push(i) });
  const s = await h.start({ source: "claude", path: "/Users/me/export.zip" });
  assert.equal(s.ok, true);
  assert.deepEqual(client.calls[0], { method: "POST", path: "start", body: { source: "claude", path: "/Users/me/export.zip", engine: { kind: "local" } } });
  const p1 = await h.job("job-1");
  assert.equal(p1.job.state, "extracting");
  assert.equal(found.length, 0, "not counted while it runs");
  const p2 = await h.job("job-1");
  assert.equal(p2.job.state, "done");
  await h.job("job-1");
  assert.equal(found.length, 1, "counted once per job");
  assert.deepEqual(found[0], { source: "claude", local: true, state: "done", found: 2 });

  const r = await h.save("job-1", ["c0-2", "c0-2", "not-listed", 7]);
  assert.deepEqual(r, { ok: true, result: { saved: 1, skipped: 1, conflicts: 0, failed: 0, receiptId: "r9" } });
  const saveCall = client.calls.find((c) => c.path === "jobs/job-1/save");
  assert.deepEqual(saveCall.body, { approvedIds: ["c0-2"] });
  assert.deepEqual(saved, [{ source: "claude", local: true, state: "done", found: 2, saved: 1, skipped: 1 }]);
});

test("nothing ticked saves nothing and does not ask the agent", async () => {
  const client = fakeClient({ answers: { "GET jobs/job-1": { status: 200, body: { job: rawJob({ state: "done", candidates: [cand("c0-1")] }) } } } });
  const h = F.createImportFactsHandlers({ client, stat: zipStat });
  await h.job("job-1");
  const r = await h.save("job-1", []);
  assert.deepEqual(r.result, { saved: 0, skipped: 0, conflicts: 0, failed: 0, receiptId: null });
  assert.equal(client.calls.some((c) => c.path.endsWith("/save")), false);
});

test("an agent error on start reaches the window in words; a bad job id never reaches the agent", async () => {
  const client = fakeClient({
    answers: { "POST start": { status: 422, body: { error: { message: "no local model", type: "invalid_request_error", param: "engine", code: "no_local_model" } } } },
  });
  const h = F.createImportFactsHandlers({ client, stat: zipStat });
  const r = await h.start({ source: "chatgpt", path: "/x.zip" });
  assert.equal(r.ok, false);
  assert.match(r.error, /No local model/);
  const bad = await h.job("../../sessions");
  assert.equal(bad.ok, false);
  assert.equal(client.calls.length, 1);
});

test("stop and forget call the agent's own routes", async () => {
  const client = fakeClient();
  const h = F.createImportFactsHandlers({ client, stat: zipStat });
  assert.deepEqual(await h.stop("job-1"), { ok: true });
  assert.deepEqual(await h.forget("job-1"), { ok: true });
  assert.deepEqual(client.calls.map((c) => c.method + " " + c.path), ["POST jobs/job-1/stop", "DELETE jobs/job-1"]);
});

test("a request that never got an answer is a message, not a throw", async () => {
  const client = fakeClient({ importFactsRoute: async () => { throw new Error("ECONNREFUSED"); } });
  const h = F.createImportFactsHandlers({ client, stat: zipStat });
  const r = await h.start({ source: "claude", path: "/x.zip" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not reach the agent/);
});

test("import_facts keeps counts and enums only, never a fact or a path", () => {
  const v = V.validateEvent("import_facts", {
    step: "saved", source: "chatgpt", engine: "local", state: "done", found: 4, saved: 3, skipped: 1, value: "secret", path: "/Users/me/x.zip",
  }, "main");
  assert.deepEqual(v, { event: "import_facts", props: { step: "saved", source: "chatgpt", engine: "local", state: "done", found: 4, saved: 3, skipped: 1 } });
  assert.equal(V.validateEvent("import_facts", { step: "saved" }, "ui"), null, "main owns it");
});
