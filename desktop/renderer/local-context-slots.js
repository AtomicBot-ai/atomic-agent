/* ---------------- ATO-336: context size and slots for the local model ----------------
   Loaded before renderer.js; declares only. The pure part (the choices and
   the values they write) is shared with the Node checks
   (test/local-context-slots.test.mjs); the pane part at the bottom calls
   renderer.js helpers at click and paint time.

   Nadya's call (25.10.2026, option A): Context size is a short list, Auto /
   32K / 64K / 128K / the model's maximum, and never more than the model can
   hold; the slot count (llama-server `--parallel`) sits under Advanced.
   The keys are the agent's own: `localModels.managed.contextSize` (0 = auto:
   start small and grow, PR #859; a positive number is pinned, clamped by the
   agent to the model's trained ceiling) and `localModels.managed.parallel`
   ("auto" since config v63, or a pinned 1..8). */

const LCS_FIXED_CONTEXTS = [32768, 65536, 131072];
const LCS_SLOT_CHOICES = ['auto', 1, 2, 4];
const LCS_SLOTS_MAX = 8; // localModels.managed.parallel is bounded to 1..8
const LCS_CONTEXT_CEILING = 16 * 1048576; // a sanity bound on a written value, far past any model

/* "128K" → 131072, "1M" → 1048576, "32768" → 32768; null for "—", "" or junk.
   The catalogue's K is the binary one llama.cpp counts in (128K = 131072). */
function lcsParseContextLabel(label) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(label == null ? '' : label));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const mult = /m/i.test(m[2]) ? 1048576 : /k/i.test(m[2]) ? 1024 : 1;
  const v = Math.round(n * mult);
  return v > 0 ? v : null;
}

/* A context size in the words the list uses: 65536 → "64K", 1048576 → "1M". */
function lcsContextWord(n) {
  if (!n) return 'Auto';
  if (n % 1048576 === 0) return (n / 1048576) + 'M';
  if (n >= 1024) return (Math.round(n / 1024 * 10) / 10) + 'K';
  return String(n);
}

/* What `contextSize` holds, as a number: 0 (auto) for missing or junk. */
function lcsStoredContext(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/* What `parallel` holds: "auto" for missing, "auto" or junk; else 1..8. */
function lcsStoredSlots(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= LCS_SLOTS_MAX ? n : 'auto';
}

/**
 * The Context size choices, in order. `maxLabel` is the model's own
 * maximum as the catalogue says it ("128K"); unknown (a model added from
 * Hugging Face, no model picked) offers the fixed sizes and no Max, since
 * there is no number to write for it. Known, nothing above it is offered.
 * A stored value that is none of the choices (set from the terminal) gets
 * a choice of its own, so the list never lights something not in force.
 * @returns {{value:number, label:string, tip:string, on:boolean}[]}
 */
function lcsContextOptions(storedRaw, maxLabel) {
  const stored = lcsStoredContext(storedRaw);
  const max = lcsParseContextLabel(maxLabel);
  const out = [{value: 0, label: 'Auto', tip: 'Starts small and grows when a chat needs more'}];
  for (const v of LCS_FIXED_CONTEXTS) {
    if (max === null || v < max) out.push({value: v, label: lcsContextWord(v), tip: lcsContextWord(v) + ' tokens of context'});
  }
  if (max !== null) out.push({value: max, label: 'Max ' + lcsContextWord(max), tip: 'The most this model can hold: ' + lcsContextWord(max) + ' tokens'});
  if (stored && !out.some((o) => o.value === stored)) {
    out.push({value: stored, label: lcsContextWord(stored), tip: 'Set outside the app: ' + stored + ' tokens'});
    out.sort((a, b) => a.value - b.value);
  }
  return out.map((o) => ({...o, on: o.value === stored}));
}

/** The Parallel slots choices: Auto, 1, 2, 4, and a stored pin that is none of them. */
function lcsSlotOptions(storedRaw) {
  const stored = lcsStoredSlots(storedRaw);
  const values = LCS_SLOT_CHOICES.slice();
  if (stored !== 'auto' && !values.includes(stored)) {
    values.push(stored);
    values.sort((a, b) => (a === 'auto' ? 0 : a) - (b === 'auto' ? 0 : b));
  }
  return values.map((v) => ({
    value: v,
    label: v === 'auto' ? 'Auto' : String(v),
    tip: v === 'auto' ? 'The app picks how many chats the model serves at once' : v === 1 ? 'One request at a time' : v + ' requests at once, sharing the context',
    on: v === stored,
  }));
}

/* The string `config set localModels.managed.contextSize` takes for a
   choice, or null for one that is not a size ("0" is Auto). */
function lcsContextConfigValue(choice) {
  const s = String(choice == null ? '' : choice).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= LCS_CONTEXT_CEILING ? String(n) : null;
}

/* The string `config set localModels.managed.parallel` takes, or null. */
function lcsSlotConfigValue(choice) {
  const s = String(choice == null ? '' : choice).trim().toLowerCase();
  if (s === 'auto') return 'auto';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= LCS_SLOTS_MAX ? String(n) : null;
}

/* What the pane says after a write. */
function lcsSaidLine(which, value, restarted) {
  const what = which === 'ctx'
    ? 'Context size: ' + (value === '0' ? 'Auto' : lcsContextWord(Number(value)))
    : 'Parallel slots: ' + (value === 'auto' ? 'Auto' : value);
  return what + (restarted ? '. The model server restarted with it.' : '. It applies the next time the model server starts.');
}

if (typeof module !== 'undefined') {
  module.exports = {
    LCS_FIXED_CONTEXTS, lcsParseContextLabel, lcsContextWord, lcsStoredContext, lcsStoredSlots,
    lcsContextOptions, lcsSlotOptions, lcsContextConfigValue, lcsSlotConfigValue, lcsSaidLine,
  };
}

/* ---- the pane (renderer only; uses renderer.js globals at call time) ---- */

const LCS = {busy: null}; // the key being written, or null

/* The catalogue's "context" cell for the model the managed server runs. */
function lcsModelMaxLabel() {
  const id = llmManaged().modelId;
  const row = id && Array.isArray(LLMP.local) ? LLMP.local.find((m) => m.id === id) : null;
  return row ? row.context : null;
}

function lcsSegHTML(act, opts, label) {
  return '<span class="tk-seg llm-tuneseg" role="group" aria-label="' + esc(label) + '">'
    + opts.map((o) => '<button class="' + (o.on ? 'on' : '') + '" aria-pressed="' + o.on + '" data-act="llm:' + act + ':' + o.value + '"'
      + ' title="' + esc(o.tip) + '"' + (LCS.busy ? ' disabled' : '') + '>' + esc(o.label) + '</button>').join('') + '</span>';
}

/* Local models › Context: one row, under Reasoning. */
function lcsContextHTML() {
  return '<section class="llm-section llm-tune"><div class="tk-sh llm-sh"><span class="llm-sh-t">Context</span>'
    + (LCS.busy ? '<span class="tk-spin"></span>' : '') + '</div>'
    + '<div class="llm-tune-card">'
    + llmTuneRowHTML('Context size', 'How much of a chat the model can see at once. Auto starts small and grows when a chat needs more. A bigger size uses more memory.',
        lcsSegHTML('ctx', lcsContextOptions(llmManaged().contextSize, lcsModelMaxLabel()), 'Context size'))
    + '</div></section>';
}

/* Advanced › Engine: the slot count row. */
function lcsSlotsRowHTML() {
  return llmTuneRowHTML('Parallel slots', 'How many requests the local model serves at once. They share the context size. Auto picks from the context.',
    lcsSegHTML('slots', lcsSlotOptions(llmManaged().parallel), 'Parallel slots'));
}

/* A choice clicked: write the key, then restart the model server when it is
   up (stop and start, refused while a turn runs, as Restart model does). */
async function lcsSet(which, raw) {
  if (!BR || LCS.busy) return;
  const path = which === 'ctx' ? 'localModels.managed.contextSize' : 'localModels.managed.parallel';
  const value = which === 'ctx' ? lcsContextConfigValue(raw) : lcsSlotConfigValue(raw);
  if (value === null) return;
  const current = which === 'ctx' ? String(lcsStoredContext(llmManaged().contextSize)) : String(lcsStoredSlots(llmManaged().parallel));
  if (current === value) return;
  LCS.busy = path; llmRepaint();
  const res = await BR.configSet(path, value);
  if (!res || res.ok === false) { LCS.busy = null; LLMP.msg = {text: '! ' + llmFail(path + ' write failed', res)}; llmRepaint(); return; }
  await refreshLiveConfig();
  const up = llmLocalModels().mode === 'managed' && !!llmManaged().modelId && llmServerUp();
  LLMP.msg = null;
  const restarted = up ? await llmRestartModel() : false;
  LCS.busy = null;
  if (!up || restarted) LLMP.msg = {text: lcsSaidLine(which, value, restarted)};
  else {
    // The restart was refused (a turn is running) or failed: the value is saved, and the reason stays on screen.
    const why = LLMP.msg && LLMP.msg.text ? ' ' + String(LLMP.msg.text).replace(/^! /, '') : '';
    LLMP.msg = {text: '! ' + lcsSaidLine(which, value, false) + why};
  }
  llmRepaint();
}
