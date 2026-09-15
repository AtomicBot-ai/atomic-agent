import { Menu } from "electron";

import { configGet, configSetWhole, setActiveTextProvider, type UserConfigShape } from "./agent-cli.js";
import {
  describeFusionBlocker,
  describeFusionIntro,
  describeRunMode,
  parseRunModeCommand,
  planEnterFusion,
  planFusionWorkers,
  planSwapLegs,
  resolveRunMode,
  SWAP_NEEDS_FUSION,
  type FusionFacts,
  type RunModeConfig,
} from "./run-mode.js";

/**
 * Run mode — Fusion, in the smoke.
 *
 * What can be asserted without a live cloud key: the resolver, the
 * pre-flight and every sentence on both sides of the IPC (main's port and
 * the renderer's), the write each planner makes to a seeded config, the
 * switch the composer draws for that config, what `fusion_worker` frames
 * become, the labels, `/runmode`, the native menu, and that a route switch
 * leaving Fusion really leaves it in the file. The driven pass
 * (test/fusion.drive.mjs) clicks the same switch for real.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type RunModeBlock = NonNullable<NonNullable<RunModeConfig["llm"]>["runMode"]>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
    : v;
const sameSorted = (a: unknown, b: unknown) => same(sorted(a), sorted(b));

const PROVIDERS = [
  { id: "local-llama", kind: "llama-server" },
  { id: "aimlapi", kind: "aimlapi", defaultChatModel: "x-ai/grok-4-6" },
  { id: "openrouter", kind: "openrouter", defaultChatModel: "qwen/qwen3.7-flash" },
];
function seed(active: string, runMode?: RunModeBlock, parallel: number | string = "auto"): RunModeConfig {
  return {
    llm: { activeTextProvider: active, providers: clone(PROVIDERS), ...(runMode ? { runMode } : {}) },
    localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b", parallel } },
  };
}

interface ProbeRow { type: string; id: string; label: string; detail: string; active: boolean }
interface Probe {
  backend: string;
  kinds: string[];
  chips: Array<[string, string]>;
  swap: boolean;
  rows: { backend: ProbeRow[]; provider: ProbeRow[]; workers: ProbeRow[] | null };
  settings: { active: string | null; status: string; workersOn: string; workerButtons: number };
}

export async function fusionSmokeTest(js: Js, check: Check): Promise<void> {
  const cfgs: Record<string, RunModeConfig> = {
    cloud: seed("aimlapi"),
    local: seed("local-llama"),
    fusion: seed("aimlapi", { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "openrouter", workers: 3 } }),
    fusionHandSwitched: seed("openrouter", { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "openrouter" } }),
    fusionLocalWorkers: seed("aimlapi", { mode: "fusion" }),
    fusionOneProvider: { llm: { activeTextProvider: "local-llama", providers: [{ id: "local-llama", kind: "llama-server" }], runMode: { mode: "fusion" } } },
    noLlm: {},
  };

  /* ---- the resolver, both sides ---- */
  const mains = Object.fromEntries(Object.entries(cfgs).map(([k, c]) => [k, resolveRunMode(c)]));
  const rends = await js<Record<string, unknown>>(
    `(() => { const c = ${JSON.stringify(cfgs)}; const o = {}; for (const k in c) o[k] = window.__rmResolve(c[k]); return o; })()`,
  );
  const disagree = Object.keys(cfgs).filter((k) => !same(mains[k], rends[k]));
  check("fusion: the renderer resolves the run mode as main does", disagree.length === 0,
    disagree.length ? `differs for ${disagree.join(", ")}: ${JSON.stringify(rends[disagree[0]!])}` : `${Object.keys(cfgs).length} configs`);
  check(
    "fusion: effective only while the orchestrator is the active provider",
    mains.fusion!.effective === "fusion" && mains.fusionLocalWorkers!.effective === "fusion"
      && mains.fusionLocalWorkers!.workerProviderId === "local-llama"
      && mains.fusionHandSwitched!.effective === "cloud" && mains.cloud!.effective === "cloud"
      && mains.local!.effective === "local" && mains.fusionOneProvider!.degraded?.reason === "no-cloud-provider",
    Object.entries(mains).map(([k, v]) => `${k}=${v.effective}`).join(" "),
  );

  const status = Object.fromEntries(Object.entries(cfgs).map(([k, c]) => [k, describeRunMode(resolveRunMode(c))]));
  const rStatus = await js<Record<string, string>>(
    `(() => { const c = ${JSON.stringify(cfgs)}; const o = {}; for (const k in c) o[k] = window.__rmDescribe(c[k]); return o; })()`,
  );
  check("fusion: /runmode status reads the same on both sides", same(status, rStatus), status.fusion);
  check(
    "fusion: /runmode status names both legs, and a stored mode that is not in force",
    status.fusion === "Fusion — orchestrator aimlapi (x-ai/grok-4-6), 3 workers on openrouter (qwen/qwen3.7-flash)"
      && /stored fusion, effective cloud — the orchestrator provider is not the active one; pick the mode again to re-apply$/.test(status.fusionHandSwitched!)
      && status.fusionOneProvider!.includes("Fusion needs a cloud orchestrator"),
    status.fusionHandSwitched,
  );

  /* ---- the pre-flight's one line ---- */
  const cases: Array<[FusionFacts, string | null]> = [
    [{ readyIds: ["aimlapi"], localLoaded: true, localDownloaded: false }, "needs a second provider for the workers — Manage › LLM"],
    [{ readyIds: [], localLoaded: true, localDownloaded: true }, "needs a second provider to orchestrate — Manage › LLM › Cloud"],
    [{ readyIds: [], localLoaded: true, localDownloaded: false }, "needs two providers, one per leg — Manage › LLM"],
    [{ readyIds: ["aimlapi"], localLoaded: true, localDownloaded: true }, null],
    [{ readyIds: ["aimlapi", "openrouter"], localLoaded: true, localDownloaded: false }, null],
    [{ readyIds: ["aimlapi"], localLoaded: false, localDownloaded: false }, null],
  ];
  const mBlock = cases.map(([f]) => describeFusionBlocker(cfgs.cloud, f));
  const rBlock = await js<Array<string | null>>(
    `(${JSON.stringify(cases.map(([f]) => f))}).map((f) => window.__fzBlocker(${JSON.stringify(cfgs.cloud)}, f))`,
  );
  check("fusion: pre-flight copy is the TUI's, on both sides (6 cases)",
    same(mBlock, cases.map(([, want]) => want)) && same(rBlock, mBlock), JSON.stringify(rBlock));

  /* ---- intro and parse ---- */
  const intro = describeFusionIntro(resolveRunMode(cfgs.fusion));
  const rIntro = await js<string[]>(`window.__fzIntro(${JSON.stringify(cfgs.fusion)})`);
  check("fusion: the first-switch intro names the two resolved legs, on both sides",
    same(intro, rIntro) && intro[1]!.startsWith("Right now — x-ai/grok-4-6 plans.") && intro[1]!.includes(" qwen/qwen3.7-flash executes:")
      && !intro.join(" ").includes("ctrl+r"),
    intro[1]!.slice(0, 60));
  const inputs = ["", "status", "swap", "workers 3", "workers 9", "Fusion", " cloud ", "local", "bogus"];
  const mParse = inputs.map(parseRunModeCommand);
  const rParse = await js<unknown[]>(`(${JSON.stringify(inputs)}).map((s) => window.__fzParse(s))`);
  check("fusion: /runmode parses the TUI verbs the same on both sides",
    same(mParse, rParse) && mParse[0]!.openSwitch && mParse[3]!.workers === 3 && mParse[5]!.mode === "fusion"
      && /^workers must be 1-8 — usage: \/runmode/.test(mParse[4]!.error ?? "") && /^unknown run mode "bogus"/.test(mParse[8]!.error ?? ""),
    JSON.stringify(rParse[4]));

  /* ---- the writes, through the planners ---- */
  const a = clone(cfgs.cloud);
  const va = planEnterFusion(a, {}, (p) => p.id === "aimlapi");
  check("fusion: entering writes the mode, the active orchestrator and both pins in one change",
    va.write && !va.refusal && a.llm?.activeTextProvider === "aimlapi"
      && same(a.llm?.runMode, { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "local-llama" } })
      && va.after?.effective === "fusion" && same(a.llm?.providers, PROVIDERS) && same(a.localModels, cfgs.cloud!.localModels),
    JSON.stringify(a.llm?.runMode));
  const b = clone(cfgs.local);
  planEnterFusion(b, {}, (p) => p.id === "openrouter");
  check("fusion: from the local route the orchestrator is the first cloud provider with a key",
    b.llm?.activeTextProvider === "openrouter" && b.llm?.runMode?.fusion?.orchestratorProvider === "openrouter"
      && b.llm?.runMode?.fusion?.workerProvider === "local-llama",
    JSON.stringify(b.llm?.runMode));
  const c = clone(cfgs.cloud);
  planEnterFusion(c, { workerProvider: "openrouter" }, () => true);
  check("fusion: a workers pin keeps the orchestrator where it is",
    c.llm?.activeTextProvider === "aimlapi" && c.llm?.runMode?.fusion?.workerProvider === "openrouter", JSON.stringify(c.llm?.runMode));
  const one = clone(cfgs.fusionOneProvider);
  const vOne = planEnterFusion(one, {}, () => true);
  check("fusion: one provider is refused in the resolver's words and writes nothing",
    !vOne.write && vOne.refusal?.startsWith("Fusion needs two providers") === true && same(one, cfgs.fusionOneProvider), vOne.refusal);

  const notFusion = clone(cfgs.cloud);
  const vs0 = planSwapLegs(notFusion, () => true);
  const pinned = seed("aimlapi", { mode: "fusion", fusion: { orchestratorProvider: "aimlapi", workerProvider: "openrouter", orchestratorModel: "m-o", workerModel: "m-w" } });
  const vs1 = planSwapLegs(pinned, () => true);
  check("fusion: swap refuses off Fusion with the TUI's words, and trades both pins and model labels",
    !vs0.write && vs0.refusal === SWAP_NEEDS_FUSION && vs1.write && pinned.llm?.activeTextProvider === "openrouter"
      && sameSorted(pinned.llm?.runMode?.fusion, { orchestratorProvider: "openrouter", workerProvider: "aimlapi", orchestratorModel: "m-w", workerModel: "m-o" }),
    `${vs0.refusal} · ${JSON.stringify(pinned.llm?.runMode?.fusion)}`);

  const w = clone(cfgs.fusion);
  const vw = planFusionWorkers(w, 4);
  const w1 = seed("aimlapi", { mode: "fusion" }, 1);
  const vw1 = planFusionWorkers(w1, 1);
  const vw9 = planFusionWorkers(clone(cfgs.fusion), 9);
  check("fusion: workers write fusion.workers and managed.parallel together, with the TUI's notice",
    vw.write && w.llm?.runMode?.fusion?.workers === 4 && w.localModels?.managed?.parallel === 4
      && w.llm?.runMode?.mode === "fusion" && w.llm?.activeTextProvider === "aimlapi"
      && vw.notice === "fusion: 4 workers — restart the local daemon (Manage › LLM › Local, `s`) to apply --parallel 4"
      && vw1.notice === "fusion: 1 worker" && !vw9.write && vw9.refusal === "workers must be an integer 1-8, got 9",
    `${vw.notice} · ${vw1.notice} · ${vw9.refusal}`);

  /* ---- the switch the composer draws for a seeded config ---- */
  const probe = (cfg: RunModeConfig, facts: object) =>
    js<Probe>(`window.__fzProbe(${JSON.stringify(cfg)}, ${JSON.stringify(facts)})`);
  const chip = (p: Probe, kind: string) => p.chips.find(([k]) => k === kind)?.[1] ?? null;

  const pBlocked = await probe(cfgs.cloud, { readyIds: ["aimlapi"], localLoaded: true, local: [] });
  const rowBlocked = pBlocked.rows.backend.find((r) => r.id === "fusion");
  check("fusion: the backend popover lists fusion last, carrying the pre-flight's line",
    same(pBlocked.rows.backend.map((r) => r.id), ["cloud", "local", "custom", "fusion"])
      && rowBlocked?.detail === "needs a second provider for the workers — Manage › LLM" && !rowBlocked.active
      && pBlocked.backend === "cloud" && pBlocked.kinds.length === 3 && !pBlocked.swap && chip(pBlocked, "workers") === null,
    JSON.stringify(rowBlocked));
  const pReady = await probe(cfgs.cloud, { readyIds: ["aimlapi", "openrouter"], localLoaded: true, local: [] });
  check("fusion: unblocked, the row says what it would run",
    pReady.rows.backend.find((r) => r.id === "fusion")?.detail === "cloud plans · 2 local workers",
    pReady.rows.backend.find((r) => r.id === "fusion")?.detail);

  const pF = await probe(cfgs.fusion, { readyIds: ["aimlapi", "openrouter"], localLoaded: true, local: [] });
  check("fusion: chips follow the effective mode — fusion · orchestrator · its model ⇄ workers",
    pF.backend === "fusion" && same(pF.kinds, ["backend", "provider", "model", "workers"])
      && chip(pF, "backend") === "fusion" && chip(pF, "provider") === "aimlapi"
      && /grok-4-6/.test(chip(pF, "model") ?? "") && /qwen3\.7-flash/.test(chip(pF, "workers") ?? "") && pF.swap
      && pF.rows.backend.find((r) => r.id === "fusion")?.active === true,
    JSON.stringify(pF.chips));
  check("fusion: provider rows under Fusion are the orchestrator seat",
    same(pF.rows.provider.map((r) => [r.id, r.detail, r.active]), [["aimlapi", "orchestrator", true], ["openrouter", "orchestrator", false], ["add", "opens the wizard", false]]),
    JSON.stringify(pF.rows.provider.map((r) => [r.id, r.detail, r.active])));
  check("fusion: workers rows — every cloud provider but the orchestrator, then the download link",
    same(pF.rows.workers?.map((r) => [r.id, r.detail, r.active]), [["openrouter", "workers · in the cloud", true], ["downloadMore", "opens the local models pane", false]]),
    JSON.stringify(pF.rows.workers?.map((r) => [r.id, r.detail, r.active])));
  check("fusion: Settings › LLM marks Fusion active, states it, and offers workers 1–8 on the stored count",
    pF.settings.active === "runmode:fusion" && pF.settings.status === status.fusion
      && pF.settings.workersOn === "3" && pF.settings.workerButtons === 8,
    JSON.stringify(pF.settings));

  const onDisk = [{ id: "qwen-3.5-4b", family: "qwen", size: "2.7 GB", context: "256K", downloaded: true, active: true }];
  const pL = await probe(cfgs.fusionLocalWorkers, { readyIds: ["aimlapi"], localLoaded: true, local: onDisk });
  check("fusion: with a model on disk the workers run it and local-llama may orchestrate",
    same(pL.rows.workers?.map((r) => [r.id, r.detail, r.active]), [["qwen-3.5-4b", "workers · on this machine", true], ["openrouter", "no API key", false], ["downloadMore", "opens the local models pane", false]])
      && pL.rows.provider.some((r) => r.id === "local-llama" && r.detail === "orchestrator · runs on this machine" && !r.active)
      && chip(pL, "workers") === "qwen-3.5-4b",
    JSON.stringify(pL.rows.workers?.map((r) => [r.id, r.detail, r.active])));

  const pH = await probe(cfgs.fusionHandSwitched, { readyIds: ["aimlapi", "openrouter"], localLoaded: true, local: [] });
  const pD = await probe(cfgs.cloud, { readyIds: ["aimlapi"], localLoaded: true, local: [] });
  check("fusion: a stored fusion that is not in force draws cloud, and Settings says so; the count defaults to 2",
    pH.backend === "cloud" && chip(pH, "backend") === "cloud" && pH.settings.active === "runmode:cloud"
      && pH.settings.status.includes("stored fusion, effective cloud") && pD.settings.workersOn === "2",
    `${pH.backend} · ${pH.settings.status}`);

  /* ---- fusion_worker frames ---- */
  const frames = [
    { object: "atomic.fusion_worker", task_id: "fusion.delegate", title: "2 tasks", phase: "tool", role: "orchestrator", model: "x-ai/grok-4-6", tool: "fusion.delegate" },
    { object: "atomic.fusion_worker", task_id: "t1", title: "write the parser", phase: "started", role: "worker", model: "qwen-3.5-4b" },
    { object: "atomic.fusion_worker", task_id: "t1", title: "write the parser", phase: "tool", role: "worker", model: "qwen-3.5-4b", tool: "os.fs.write" },
    { object: "atomic.fusion_worker", task_id: "t2", title: "tests", phase: "started", role: "worker", model: "qwen-3.5-4b" },
    { object: "atomic.fusion_worker", task_id: "t1", title: "write the parser", phase: "finished", role: "worker", model: "qwen-3.5-4b", step_count: 7, summary: "wrote 3 files" },
    { object: "atomic.fusion_worker", task_id: "t2", title: "tests", phase: "failed", role: "worker", model: "qwen-3.5-4b", summary: "timed out" },
  ];
  type EvProbe = { live: string[]; strip: string[]; stripControls: number; lines: string[]; beforeReply: boolean };
  const mid = await js<EvProbe>(`window.__fzEventProbe(${JSON.stringify(frames.slice(0, 4))})`);
  const end = await js<EvProbe>(`window.__fzEventProbe(${JSON.stringify(frames)})`);
  check("fusion: the live list shows each worker as `title · model — tool|working|done`, drawn under the composer with no control",
    same(mid.live, ["write the parser · qwen-3.5-4b — os.fs.write", "tests · qwen-3.5-4b — working"])
      && same(mid.strip, mid.live) && mid.stripControls === 0
      && same(end.live, ["write the parser · qwen-3.5-4b — done", "tests · qwen-3.5-4b — done"]),
    `${JSON.stringify(mid.strip)} → ${JSON.stringify(end.live)} · controls ${mid.stripControls}`);
  check("fusion: every frame is a transcript line in the TUI's words, placed before the reply",
    same(end.lines, [
      "orchestrator · x-ai/grok-4-6 — fusion.delegate (2 tasks)",
      "worker write the parser · qwen-3.5-4b: started",
      "worker write the parser · qwen-3.5-4b — os.fs.write",
      "worker tests · qwen-3.5-4b: started",
      "worker write the parser · qwen-3.5-4b: done — 7 steps, wrote 3 files",
      "worker tests · qwen-3.5-4b: failed — timed out",
    ]) && end.beforeReply,
    JSON.stringify(end.lines));

  /* ---- labels, slash, leftovers, menu ---- */
  const cat = await js<{ label: string | null; level: number | null }>("window.__approvalCat('fusion_fanout')");
  check("fusion: the fan-out approval reads `fusion · fan-out` at level 4", cat.label === "fusion · fan-out" && cat.level === 4, JSON.stringify(cat));
  const slash = await js<string[]>("window.__slashNames()");
  check("fusion: /runmode replaces the prototype /run", slash.includes("runmode") && !slash.includes("run"), slash.filter((s) => /^run/.test(s)).join(","));
  const leftovers = await js<{ blurb: string; dial: string; state: boolean; dialEl: boolean; toast: unknown; toastAfter: unknown }>(
    `(() => { const t0 = window.__lastToast();
       document.dispatchEvent(new KeyboardEvent('keydown', {key:'r', ctrlKey:true, bubbles:true, cancelable:true}));
       return {blurb: typeof shareBlurb, dial: typeof refreshDial, state: ('share' in S) || ('dialShare' in S) || ('mode' in S),
               dialEl: !!document.getElementById('dial'), toast: t0, toastAfter: window.__lastToast()}; })()`,
  );
  check("fusion: the prototype share slider, its state and ctrl+r cycling are gone",
    leftovers.blurb === "undefined" && leftovers.dial === "undefined" && !leftovers.state && !leftovers.dialEl
      && same(leftovers.toast, leftovers.toastAfter),
    JSON.stringify(leftovers));

  const runMenu = Menu.getApplicationMenu()?.items.find((i) => i.label === "Run");
  const where = runMenu?.submenu?.items.find((i) => i.label === "Where it runs…");
  check("fusion: Run › Where it runs… offers Local, Cloud and Fusion",
    same(where?.submenu?.items.map((i) => i.label), ["Local", "Cloud", "Fusion"]),
    JSON.stringify(where?.submenu?.items.map((i) => i.label) ?? null));

  /* ---- /runmode through the composer's own slash path ---- */
  const live = (await configGet()).config as RunModeConfig | undefined;
  const liveStatus = live ? describeRunMode(resolveRunMode(live)) : "";
  const routed = await js<{ bad: string; status: string; opened: boolean; kind: string; swapToast: string | null; storedFusion: boolean }>(
    `(() => { const n0 = S.log.length;
       const lastSys = () => { const s = S.log.filter((m) => m.k === 'system'); return s.length ? s[s.length - 1].text : ''; };
       window.__runSlash('/runmode workers 9'); const bad = lastSys();
       window.__runSlash('/runmode status'); const status = lastSys();
       window.__runSlash('/runmode'); const sel = window.__sel();
       closeSelector();
       const storedFusion = rmNow().stored === 'fusion';
       if (!storedFusion) window.__runSlash('/runmode swap');
       const t = window.__lastToast();
       S.log.splice(n0); render();
       return {bad, status, opened: sel.open, kind: sel.kind, swapToast: t ? t.t : null, storedFusion}; })()`,
  );
  const escaped = await js<string>(`esc(${JSON.stringify(liveStatus)})`);
  check("fusion: /runmode routes — usage on a bad count, status from the resolver, bare opens Where it runs, swap refuses off Fusion",
    routed.bad === await js<string>(`esc(${JSON.stringify(parseRunModeCommand("workers 9").error)})`)
      && routed.status === escaped && routed.opened && routed.kind === "backend"
      && (routed.storedFusion || routed.swapToast === SWAP_NEEDS_FUSION),
    JSON.stringify(routed));

  /* ---- leaving Fusion writes the stored mode (the switch-to-cloud bug) ---- */
  const before = (await configGet()).config as UserConfigShape | undefined;
  const activeId = before?.llm?.activeTextProvider;
  if (!before?.llm || !activeId) {
    check("fusion: a route switch that leaves Fusion writes the stored mode with the provider", false, "no llm block in this state dir");
    return;
  }
  try {
    const staged = clone(before);
    staged.llm!.runMode = { ...staged.llm!.runMode, mode: "fusion" };
    await configSetWhole(staged);
    const plain = await setActiveTextProvider(activeId);
    const afterPlain = ((await configGet()).config as UserConfigShape).llm?.runMode?.mode;
    const leave = await setActiveTextProvider(activeId, { leaveFusion: true });
    const afterLeave = (await configGet()).config as UserConfigShape;
    const kind = (afterLeave.llm?.providers ?? []).find((p) => p.id === activeId)?.kind;
    check("fusion: a route switch that leaves Fusion writes the stored mode with the provider",
      plain.ok && !plain.changed && afterPlain === "fusion" && leave.ok && leave.changed
        && afterLeave.llm?.runMode?.mode === (kind === "llama-server" ? "local" : "cloud")
        && afterLeave.llm?.activeTextProvider === activeId,
      `without leaveFusion: ${afterPlain}; with it: ${afterLeave.llm?.runMode?.mode} on ${activeId}`);
  } finally {
    await configSetWhole(before);
  }
}
