// Unit tests for main/studio-gpu-share.ts, against the built output.
// Run: npm run build && npm run test:unit
// Local image/video generation and the local chat model on one memory: the
// chat model yields when the two do not fit (always under Atomic Core), a
// chat turn waits for a running generation, the chat model comes back after
// it, and an idle diffusion model makes room for a chat turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../out/main/studio-gpu-share.js");

const GIB = 1024 ** 3;
/** A 32 GB Mac: 85 % of RAM is the budget. */
const BUDGET = 32 * GIB * 0.85;

const snap = (over = {}) => ({
  budgetBytes: BUDGET,
  chatBytes: 6 * GIB,
  diffusionBytes: 8 * GIB,
  oneModelPerGpu: false,
  chat: "on",
  diffusion: "none",
  waitingTurns: 0,
  ...over,
});
const kinds = (actions) => actions.map((a) => a.do);

test("chatResidentBytes: the file size plus runtime overhead; unknown stays unknown", () => {
  assert.equal(G.chatResidentBytes(null), null);
  assert.equal(G.chatResidentBytes(0), null);
  assert.equal(G.chatResidentBytes(4 * GIB), Math.round(4 * GIB * G.CHAT_RUNTIME_FACTOR + G.CHAT_RUNTIME_OVERHEAD_BYTES));
});

test("canCoexist: sizes against 90 % of the budget; Core's one model per GPU never; unknown never", () => {
  assert.equal(G.canCoexist(snap()), true);
  assert.equal(G.canCoexist(snap({ chatBytes: 14 * GIB, diffusionBytes: 12 * GIB })), false);
  assert.equal(G.canCoexist(snap({ oneModelPerGpu: true })), false);
  assert.equal(G.canCoexist(snap({ chatBytes: null })), false);
  assert.equal(G.canCoexist(snap({ diffusionBytes: null })), false);
  assert.equal(G.canCoexist(snap({ budgetBytes: null })), false);
});

test("diffusion-start: the chat model yields when they do not fit, and the diffusion gets the whole budget", () => {
  const a = G.decideGpuShare("diffusion-start", snap({ chatBytes: 16 * GIB, diffusionBytes: 12 * GIB }));
  assert.deepEqual(kinds(a), ["yield-chat", "budget"]);
  assert.equal(a[1].bytes, BUDGET);
});

test("diffusion-start under Atomic Core: always yields, however small both are", () => {
  const a = G.decideGpuShare("diffusion-start", snap({ chatBytes: 1 * GIB, diffusionBytes: 1 * GIB, oneModelPerGpu: true }));
  assert.deepEqual(kinds(a), ["yield-chat", "budget"]);
});

test("diffusion-start: both fit — both stay, the diffusion load is planned against what chat leaves", () => {
  const a = G.decideGpuShare("diffusion-start", snap());
  assert.deepEqual(kinds(a), ["budget"]);
  assert.equal(a[0].bytes, BUDGET - 6 * GIB);
});

test("diffusion-start: chat on the cloud (off) or already yielded — nothing to stop", () => {
  assert.deepEqual(kinds(G.decideGpuShare("diffusion-start", snap({ chat: "off", chatBytes: 30 * GIB }))), ["budget"]);
  assert.deepEqual(kinds(G.decideGpuShare("diffusion-start", snap({ chat: "yielded", chatBytes: 30 * GIB }))), ["budget"]);
});

test("diffusion-end: a yielded chat model comes back later, or now when a turn waits; the unload waits for the resume", () => {
  assert.deepEqual(G.decideGpuShare("diffusion-end", snap({ chat: "yielded", diffusion: "idle", oneModelPerGpu: true })), [{ do: "resume-chat", when: "later" }]);
  assert.deepEqual(G.decideGpuShare("diffusion-end", snap({ chat: "yielded", diffusion: "idle", waitingTurns: 1 })), [{ do: "resume-chat", when: "now" }]);
});

test("diffusion-end: chat on and they do not fit — the idle diffusion model goes; if they fit it stays", () => {
  assert.deepEqual(kinds(G.decideGpuShare("diffusion-end", snap({ diffusion: "idle", chatBytes: 20 * GIB, diffusionBytes: 10 * GIB }))), ["unload-diffusion"]);
  assert.deepEqual(G.decideGpuShare("diffusion-end", snap({ diffusion: "idle" })), []);
  assert.deepEqual(G.decideGpuShare("diffusion-end", snap({ chat: "off", diffusion: "idle", chatBytes: 30 * GIB })), []);
});

test("chat-resume: unload the diffusion model first when they do not fit, then the chat model; never during a job", () => {
  assert.deepEqual(kinds(G.decideGpuShare("chat-resume", snap({ chat: "yielded", diffusion: "idle", oneModelPerGpu: true }))), ["unload-diffusion", "resume-chat"]);
  assert.deepEqual(kinds(G.decideGpuShare("chat-resume", snap({ chat: "yielded", diffusion: "idle" }))), ["resume-chat"]);
  assert.deepEqual(G.decideGpuShare("chat-resume", snap({ chat: "yielded", diffusion: "busy" })), []);
  assert.deepEqual(G.decideGpuShare("chat-resume", snap({ chat: "on" })), []);
});

test("chat-turn: held while a generation runs with the chat model yielded", () => {
  assert.deepEqual(kinds(G.decideGpuShare("chat-turn", snap({ chat: "yielded", diffusion: "busy" }))), ["hold-turn"]);
});

test("chat-turn: yielded but the generation is over — the model comes back now, the turn goes", () => {
  assert.deepEqual(G.decideGpuShare("chat-turn", snap({ chat: "yielded", diffusion: "idle", oneModelPerGpu: true })), [{ do: "unload-diffusion" }, { do: "resume-chat", when: "now" }]);
});

test("chat-turn: an idle diffusion model in the way is unloaded first; one that fits stays; cloud never waits", () => {
  assert.deepEqual(kinds(G.decideGpuShare("chat-turn", snap({ diffusion: "idle", oneModelPerGpu: true }))), ["unload-diffusion"]);
  assert.deepEqual(G.decideGpuShare("chat-turn", snap({ diffusion: "idle" })), []);
  assert.deepEqual(G.decideGpuShare("chat-turn", snap({ chat: "off", diffusion: "busy" })), []);
});

/* ------------------------------------------------------------ the runner */

function runner(over = {}) {
  const f = { wanted: true, fileBytes: 5 * GIB, oneModelPerGpu: true, yields: 0, resumes: [], unloads: 0, states: [] };
  const share = new G.GpuShare({
    profile: () => ({ memoryKind: "unified", ramBytes: 32 * GIB, budgetBytes: BUDGET, teOnCpu: true }),
    chat: () => ({ wanted: f.wanted, fileBytes: f.fileBytes, oneModelPerGpu: f.oneModelPerGpu }),
    yieldChat: async () => { f.yields += 1; return { token: f.yields }; },
    resumeChat: (token) => { f.resumes.push(token); },
    resumeDelayMs: 3_600_000,
    ...over,
  });
  share.attachDiffusion({ unload: async () => { f.unloads += 1; } });
  share.onState((s) => f.states.push(s));
  return { share, f };
}

test("runner: a generation yields the chat model once, a chat turn is held, and the end lets both go", async () => {
  const { share, f } = runner();
  const { budgetBytes } = await share.diffusionStart({ kind: "image", model: "z-image:q4_k_m", bytes: 9 * GIB });
  assert.equal(budgetBytes, BUDGET);
  assert.equal(f.yields, 1);
  assert.equal(share.state().chat, "yielded");
  share.jobStarted("job-1");
  const held = await share.chatTurn();
  assert.ok(held, "the turn is held while the image runs");
  assert.equal(share.state().heldTurns, 1);
  assert.equal(share.state().chatLine, "Waiting for Studio to finish the image, then the chat model loads again");
  let released = false;
  held.wait.then(() => { released = true; });
  await share.diffusionEnd({ more: false, loaded: true });
  await held.wait;
  assert.equal(released, true);
  // A turn waited: the model is back at once, and under Core the image model went first.
  assert.deepEqual(f.resumes, [{ token: 1 }]);
  assert.equal(f.unloads, 1);
  assert.equal(share.state().chat, "on");
  share.dispose();
});

test("runner: a queued generation keeps the chat model yielded; no second yield, no resume in between", async () => {
  const { share, f } = runner();
  await share.diffusionStart({ kind: "video", model: "ltx:q4", bytes: 12 * GIB });
  await share.diffusionEnd({ more: true, loaded: true });
  await share.diffusionStart({ kind: "video", model: "ltx:q4", bytes: 12 * GIB });
  assert.equal(f.yields, 1);
  assert.deepEqual(f.resumes, []);
  share.dispose();
});

test("runner: with nobody waiting the chat model comes back after the pause, not at once", async () => {
  const { share, f } = runner({ resumeDelayMs: 20 });
  await share.diffusionStart({ kind: "image", model: "z-image:q4_k_m", bytes: 9 * GIB });
  await share.diffusionEnd({ more: false, loaded: true });
  assert.deepEqual(f.resumes, []);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(f.resumes.length, 1);
  assert.equal(f.unloads, 1);
});

test("runner: a held turn stopped by the person is dropped and no longer counted", async () => {
  const { share } = runner();
  await share.diffusionStart({ kind: "image", model: "z-image:q4_k_m", bytes: 9 * GIB });
  const held = await share.chatTurn();
  held.drop();
  await held.wait;
  assert.equal(share.state().heldTurns, 0);
  share.dispose();
});

test("runner: chat on the cloud — nothing yields and chat turns are never held", async () => {
  const { share, f } = runner();
  f.wanted = false;
  await share.diffusionStart({ kind: "image", model: "z-image:q4_k_m", bytes: 9 * GIB });
  assert.equal(f.yields, 0);
  assert.equal(await share.chatTurn(), null);
  assert.equal(share.pausesChat(9 * GIB), false);
  share.dispose();
});

test("runner: the Studio hint — pausesChat under Core always, on llama-server only when they do not fit", () => {
  const { share, f } = runner();
  assert.equal(share.pausesChat(1 * GIB), true);
  f.oneModelPerGpu = false;
  assert.equal(share.pausesChat(4 * GIB), false);
  assert.equal(share.pausesChat(24 * GIB), true);
  share.dispose();
});

test("queued and waiting lines name what runs", () => {
  assert.equal(G.queuedLine("image"), "Queued after the current image");
  assert.equal(G.waitLine("video"), "Waiting for Studio to finish the video, then the chat model loads again");
});
