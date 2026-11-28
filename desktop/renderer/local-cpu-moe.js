/* ---------------- ATO-2455: experts on the CPU for a mixture-of-experts model ----------------
   Loaded before renderer.js; declares only. The pure part is shared with
   the Node checks (test/local-cpu-moe.test.mjs); the pane part at the
   bottom calls renderer.js helpers at click and paint time, like
   local-context-slots.js.

   The key is the agent's own: `localModels.managed.cpuMoe` (ATO-2380):
   "auto" (default) keeps the experts of the first few layers in system RAM
   only when the model does not fit a GPU with memory of its own; "off"
   never; a whole number 1..512 pins that many layers (llama.cpp
   `--n-cpu-moe N`). The row sits under Advanced › Engine and shows only for
   a mixture-of-experts model, or when the setting is not Auto, so it can
   always be put back. Precedent: LM Studio's "Force Model Expert Weights
   onto CPU", Jan's `--n-cpu-moe` engine setting. */

const CMOE_LAYER_CHOICES = [8, 16, 32];
const CMOE_MAX_LAYERS = 512; // the agent's CPU_MOE_MAX_PINNED_LAYERS

/* What `cpuMoe` holds: "auto" for missing or junk, "off", or 1..512. */
function cmoeStored(raw) {
  if (raw === 'off') return 'off';
  const n = Number(raw);
  return raw !== null && raw !== '' && Number.isInteger(n) && n >= 1 && n <= CMOE_MAX_LAYERS ? n : 'auto';
}

/**
 * The choices, in order: Auto, Off, 8, 16, 32 layers, and a stored pin that
 * is none of them (set from the terminal), so the row never lights
 * something not in force.
 * @returns {{value: string|number, label: string, tip: string, on: boolean}[]}
 */
function cmoeOptions(storedRaw, isMac) {
  const stored = cmoeStored(storedRaw);
  const nums = CMOE_LAYER_CHOICES.slice();
  if (typeof stored === 'number' && !nums.includes(stored)) { nums.push(stored); nums.sort((a, b) => a - b); }
  const out = [
    {value: 'auto', label: 'Auto', tip: isMac
      ? 'On a Mac the GPU shares the memory, so Auto keeps the whole model together'
      : 'Moves some experts to system RAM only when the model does not fit the GPU'},
    {value: 'off', label: 'Off', tip: 'Never moves experts off the GPU'},
  ];
  for (const n of nums) out.push({value: n, label: String(n), tip: 'The experts of the first ' + n + ' layers run on the CPU'});
  return out.map((o) => ({...o, on: o.value === stored}));
}

/* The string `config set localModels.managed.cpuMoe` takes, or null. */
function cmoeConfigValue(choice) {
  const s = String(choice == null ? '' : choice).trim().toLowerCase();
  if (s === 'auto' || s === 'off') return s;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= CMOE_MAX_LAYERS ? String(n) : null;
}

/* What the pane says after a write. */
function cmoeSaidLine(value, restarted) {
  const what = 'Experts on CPU: ' + (value === 'auto' ? 'Auto' : value === 'off' ? 'Off' : value + ' layers');
  return what + (restarted ? '. The model server restarted with it.' : '. It applies the next time the model server starts.');
}

/**
 * The Local models badge for a row the agent says fits with experts in RAM
 * (main/moe-fit.ts sets `expertsInRam`), or null to keep the RAM verdict.
 * Only over a tight fit: the agent's rule never rescues a model under its
 * minimum, and a comfortable fit says enough. Off: the setting stops it.
 * @returns {{v: string, word: string, tone: string, title: string}|null}
 */
function cmoeFitBadge(model, fit, storedRaw) {
  const e = model && model.expertsInRam;
  if (!e || !fit || fit.v !== 'tight' || cmoeStored(storedRaw) === 'off') return null;
  if (e.tier !== 'fits') return null;
  const speed = e.speed ? ' Expected speed: ' + e.speed + '.' : '';
  return {v: 'split', word: 'Fits, experts in RAM', tone: 'green',
    title: 'Fits, experts in RAM. It runs on the GPU and keeps some of its experts in system RAM: slower than all on the GPU, much faster than a model that does not fit.' + speed};
}

if (typeof module !== 'undefined') {
  module.exports = {CMOE_LAYER_CHOICES, cmoeStored, cmoeOptions, cmoeConfigValue, cmoeSaidLine, cmoeFitBadge};
}

/* ---- the pane (renderer only; uses renderer.js globals at call time) ---- */

const CMOE = {busy: false};

/* The managed model's row, when the list has it. */
function cmoeActiveModel() {
  const id = llmManaged().modelId;
  return id && Array.isArray(LLMP.local) ? LLMP.local.find((m) => m.id === id) || null : null;
}

/* Advanced › Engine: the row, for a mixture-of-experts model or a setting that is not Auto. */
function cmoeRowHTML() {
  const stored = cmoeStored(llmManaged().cpuMoe);
  const model = cmoeActiveModel();
  if (stored === 'auto' && !(model && modelIsMoe(model))) return '';
  const opts = cmoeOptions(llmManaged().cpuMoe, IS_MAC);
  const seg = '<span class="tk-seg llm-tuneseg" role="group" aria-label="Experts on CPU">'
    + opts.map((o) => '<button class="' + (o.on ? 'on' : '') + '" aria-pressed="' + o.on + '" data-act="llm:cmoe:' + o.value + '"'
      + ' title="' + esc(o.tip) + '"' + (CMOE.busy ? ' disabled' : '') + '>' + esc(o.label) + '</button>').join('') + '</span>';
  return llmTuneRowHTML('Experts on CPU',
    'For a mixture-of-experts model that is too big for the GPU: some of its experts run from system RAM. Auto does it only when needed. A number keeps that many layers’ experts on the CPU.'
      + (CMOE.busy ? ' Saving…' : ''),
    seg);
}

/* A choice clicked: write the key, then restart the model server when it is
   up, as Context size does (local-context-slots.js lcsSet). */
async function cmoeSet(raw) {
  if (!BR || CMOE.busy) return;
  const value = cmoeConfigValue(raw);
  if (value === null || String(cmoeStored(llmManaged().cpuMoe)) === value) return;
  CMOE.busy = true; llmRepaint();
  const res = await BR.configSet('localModels.managed.cpuMoe', value);
  if (!res || res.ok === false) {
    CMOE.busy = false;
    LLMP.msg = {text: '! Experts on CPU was not saved. Try again, or see Settings › Diagnostics.'};
    llmRepaint();
    return;
  }
  await refreshLiveConfig();
  const up = llmLocalModels().mode === 'managed' && !!llmManaged().modelId && llmServerUp();
  LLMP.msg = null;
  const restarted = up ? await llmRestartModel() : false;
  CMOE.busy = false;
  if (!up || restarted) LLMP.msg = {text: cmoeSaidLine(value, restarted)};
  else {
    const why = LLMP.msg && LLMP.msg.text ? ' ' + String(LLMP.msg.text).replace(/^! /, '') : '';
    LLMP.msg = {text: '! ' + cmoeSaidLine(value, false) + why};
  }
  llmRepaint();
  // The "Fits, experts in RAM" badges: Off hides them at once (cmoeFitBadge reads
  // the setting); main reads the agent's facts again in the background, and the
  // next list read shows them.
  llmRefresh();
}
