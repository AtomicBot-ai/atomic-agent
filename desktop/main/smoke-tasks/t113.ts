import { lineLevel } from "../agent-output.js";
import { cpuOnlyLogLine, cpuOnlyWorthSaying, currentRunLines, ranOnCpu } from "../cpu-only.js";
import { daemonWatchState } from "../daemon-watch.js";

/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=113`.
 *
 * ATO-244 — on a Windows PC with an RTX 3080 Ti the managed model server could
 * not load its CUDA build and ran on the CPU. llama-server.log said "no usable
 * GPU found" from its first lines; the app said nothing, and the person
 * watched "Working…" for three and a half minutes. Main now reads the log
 * after each start (main/cpu-only.ts, called from daemon-watch.ts) and the
 * window says it once per start, above the composer, while the route is the
 * local model.
 *
 * (a) The detector, a pure function over log text: only the lines after the
 *     last `[atomic-agent] launch:` line count (the log is appended to across
 *     starts), a log with no launch line says nothing, and a CPU build picked
 *     on purpose (backendVariant "cpu") is not worth a word.
 * (b) The window: the notice main sends on the app:daemonWatch channel,
 *     handed to the channel's own handler (dwatchApply). One strip for a
 *     CPU-only start on the local route, none on the cloud route, the app
 *     line said once per start, a dismissal held until the next start, "Use a
 *     cloud model" going to the existing switch (stood in), and the
 *     supervisor's own incident untouched.
 *
 * Staged on the window's own state and put back; nothing is switched and no
 * model server is started.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (x: unknown) => JSON.stringify(x);

const LAUNCH = [
  "[atomic-agent] launch: model qwen-3.5-9b (qwen35, 32 layers, trained context 262144)",
  "[atomic-agent] launch: --ctx-size 65536 fitted from the model's KV layout",
  "[atomic-agent] launch: swa-full: off (auto)",
  "[atomic-agent] launch: prefix reuse partial",
  "",
].join("\n");
const NO_GPU = [
  "warning: no usable GPU found, --gpu-layers option will be ignored",
  "warning: one possible reason is that llama.cpp was compiled without GPU support",
].join("\n");
const SERVING = [
  "main: server is listening on http://127.0.0.1:19091 - starting the main loop",
  "slot update_slots: id  0 | task 0 | prompt processing, n_tokens = 2048, progress = 0.29, t = 130.05 s / 15.75 tokens per second",
].join("\n");
const GPU_LINES = "ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 3080 Ti, compute capability 8.6";

/** Two starts in one appended log: the first on the CPU, the last on the GPU. */
const CPU_THEN_GPU = [LAUNCH, NO_GPU, SERVING, LAUNCH, GPU_LINES, SERVING].join("\n");
/** Two starts: the first on the GPU, the last on the CPU. */
const GPU_THEN_CPU = [LAUNCH, GPU_LINES, SERVING, LAUNCH, NO_GPU, SERVING].join("\n");

export async function checks113(js: Js, check: Check): Promise<void> {
  detector(check);
  mainState(check);
  await windowNotice(js, check);
}

/* (a) */
function detector(check: Check): void {
  const got = {
    cpuThenGpu: ranOnCpu(CPU_THEN_GPU),
    gpuThenCpu: ranOnCpu(GPU_THEN_CPU),
    windowsEndings: ranOnCpu(GPU_THEN_CPU.replace(/\n/g, "\r\n")),
    noLaunchLine: ranOnCpu([NO_GPU, SERVING].join("\n")),
    lastRunLines: currentRunLines(CPU_THEN_GPU)?.length ?? null,
  };
  check(
    "T113 (ATO-244): a warning from an earlier start does not speak for the last one (CPU run, then a GPU run: not CPU)",
    got.cpuThenGpu === false,
    show(got),
  );
  check(
    "T113 (ATO-244): the last start's own 'no usable GPU found' is read as a CPU run, Windows line endings too",
    got.gpuThenCpu === true && got.windowsEndings === true,
    show(got),
  );
  check(
    "T113 (ATO-244): a log with no launch line (an older agent, a cut tail) says nothing",
    got.noLaunchLine === false && currentRunLines(NO_GPU) === null,
    show(got),
  );
  const worth = {
    auto: cpuOnlyWorthSaying(GPU_THEN_CPU, "auto"),
    unset: cpuOnlyWorthSaying(GPU_THEN_CPU, undefined),
    chosenCpu: cpuOnlyWorthSaying(GPU_THEN_CPU, "cpu"),
    gpuRun: cpuOnlyWorthSaying(CPU_THEN_GPU, "auto"),
  };
  check(
    "T113 (ATO-244): a CPU run is worth a word unless the CPU build was picked on purpose (backendVariant cpu)",
    worth.auto === true && worth.unset === true && worth.chosenCpu === false && worth.gpuRun === false,
    show(worth),
  );
  const line = cpuOnlyLogLine("qwen-3.5-9b");
  check(
    "T113 (ATO-244): the agent.log line names the CPU and the model, and is a [desktop] line (main writes it at WARN)",
    line.startsWith("[desktop] local-llm: ") && line.includes("no usable GPU") && line.includes("CPU") && line.includes("qwen-3.5-9b")
      // Its own shape would read INFO; main passes WARN with it (daemon-watch lookForCpuOnly, main.ts host say).
      && lineLevel(line) === "info",
    line,
  );
}

/* What a reopened window asks main for carries the CPU word beside the supervisor's state. */
function mainState(check: Check): void {
  const st = daemonWatchState();
  check(
    "T113 (ATO-244): main's daemonWatch state carries the CPU notice for a window opened after the start",
    !!st.cpu && st.cpu.kind === "cpu_only" && typeof st.cpu.cpuOnly === "boolean" && typeof st.cpu.seq === "number",
    show(st.cpu),
  );
}

/* (b) Inside the probe below: no backticks anywhere, in code or comments. */
const PROBE = `(() => {
  if (S.pending || WAIT || SWX.hold || SWX.err || SWX.pending || S.settings || !document.getElementById('composer')) return {skipped: true};
  const keep = {cpu: Object.assign({}, CPUW), want: SWX.want, dwatch: DWATCH, text: APPSTATUS.text, tone: APPSTATUS.tone,
    logs: LOGS.slice(), choose: window.selChooseBackend};
  LOGS.length = 0;
  const strips = () => document.querySelectorAll('.statusstrip.cpuonly').length;
  const stripText = () => { const n = document.querySelector('.statusstrip.cpuonly'); return n ? n.textContent : ''; };
  const said = () => LOGS.filter((r) => /running on the processor/.test(r[2])).length;
  const sentinel = {kind: 'restarting', reason: 'smoke t113 sentinel', quickDeaths: 0};
  const chose = [];
  const base = CPUW.seq + 1000;
  const out = {skipped: false};
  try {
    DWATCH = sentinel;
    window.selChooseBackend = (id) => { chose.push(id); return Promise.resolve({ok: false, cancelled: true}); };
    SWX.want = {backend: 'local'};
    dwatchApply({kind: 'cpu_only', cpuOnly: true, seq: base + 1, modelId: 'smoke-t113'});
    out.local = {strips: strips(), text: stripText(), said: said(), dwatchKept: DWATCH === sentinel,
      button: !!document.querySelector('.statusstrip.cpuonly [data-act="cpu:cloud"]')};
    dwatchApply({kind: 'cpu_only', cpuOnly: true, seq: base + 1, modelId: 'smoke-t113'});
    render(); render();
    out.again = {strips: strips(), said: said()};
    SWX.want = {backend: 'cloud'}; render();
    out.cloud = {strips: strips()};
    SWX.want = {backend: 'local'}; render();
    act('cpu:dismiss');
    out.dismissed = {strips: strips()};
    render();
    out.dismissedStays = {strips: strips()};
    dwatchApply({kind: 'cpu_only', cpuOnly: true, seq: base + 2, modelId: 'smoke-t113'});
    out.nextStart = {strips: strips(), said: said()};
    act('cpu:cloud');
    out.cloudButton = {strips: strips(), chose: chose.slice()};
    dwatchApply({kind: 'cpu_only', cpuOnly: true, seq: base + 3, modelId: 'smoke-t113'});
    dwatchApply({kind: 'cpu_only', cpuOnly: false, seq: base + 3, modelId: 'smoke-t113'});
    out.stopped = {strips: strips(), dwatchKept: DWATCH === sentinel};
    return out;
  } finally {
    Object.assign(CPUW, keep.cpu);
    SWX.want = keep.want; DWATCH = keep.dwatch;
    window.selChooseBackend = keep.choose;
    APPSTATUS.text = keep.text; APPSTATUS.tone = keep.tone;
    LOGS.length = 0; keep.logs.forEach((r) => LOGS.push(r));
    render();
  }
})()`;

async function windowNotice(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(PROBE).catch((e: unknown) => ({ error: String(e) }) as Record<string, unknown>);
  if (r["skipped"] !== false) {
    check("T113: the probe ran (the window was idle)", false, r["error"] ? String(r["error"]) : "a turn, a switch or Settings was in the way, so nothing was staged");
    return;
  }
  type Row = { strips?: number; text?: string; said?: number; dwatchKept?: boolean; button?: boolean; chose?: string[] };
  const at = (k: string) => (r[k] ?? {}) as Row;
  const local = at("local");
  check(
    "T113 (ATO-244): a CPU-only start on the local route draws one strip with the title, the reason and Use a cloud model",
    local.strips === 1 && !!local.text && local.text.includes("This model is running on the processor")
      && local.text.includes("Your graphics card is not being used") && local.button === true,
    show(local),
  );
  check(
    "T113 (ATO-244): the CPU notice leaves the supervisor's own incident alone",
    local.dwatchKept === true && at("stopped").dwatchKept === true,
    show({ local, stopped: at("stopped") }),
  );
  check(
    "T113 (ATO-244): said once per start: the same start again and further repaints add no strip and no app line",
    local.said === 1 && at("again").strips === 1 && at("again").said === 1,
    show({ local, again: at("again") }),
  );
  check(
    "T113 (ATO-244): no strip on the cloud route",
    at("cloud").strips === 0,
    show(at("cloud")),
  );
  check(
    "T113 (ATO-244): a dismissal holds for that start, and the next start says it again (strip and app line)",
    at("dismissed").strips === 0 && at("dismissedStays").strips === 0 && at("nextStart").strips === 1 && at("nextStart").said === 2,
    show({ dismissed: at("dismissed"), stays: at("dismissedStays"), next: at("nextStart") }),
  );
  check(
    "T113 (ATO-244): Use a cloud model goes to the existing switch to the cloud and puts the strip away",
    at("cloudButton").strips === 0 && show(at("cloudButton").chose) === show(["cloud"]),
    show(at("cloudButton")),
  );
  check(
    "T113 (ATO-244): a stop (cpuOnly false) takes the strip away",
    at("stopped").strips === 0,
    show(at("stopped")),
  );
}
