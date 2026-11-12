/* ---------------- ATO-606: Fusion workers' reasoning level ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/fusion-reasoning.test.mjs).

   The agent sends `llm.runMode.fusion.workerReasoning` (low | medium |
   high) as the reasoning effort of every Fusion worker completion; with no
   key each provider keeps its own default. The planner is not affected.

   Settings › Models draws "Worker reasoning: Default · Low · Medium · High"
   under the worker count while Fusion runs, and `/runmode reasoning <level>`
   does the same from the composer. Both go to main's
   `cli:fusionWorkerReasoning` (main/fusion-reasoning-ipc.ts): one
   compare-and-swap write of the whole file, "Default" removing the key.

   The help line says honestly what the level does on the provider that runs
   the workers (src/llm/provider/openai/model-params.ts reasoningEffortField):
   OpenRouter takes `reasoning.effort`, OpenAI-compatible servers
   `reasoning_effort`, Gemini only its thinking models (2.5 and 3), AI/ML API
   only OpenAI's reasoning models. Local llama.cpp workers and subscription
   CLIs get nothing, so with local workers the line points to the local
   thinking knobs in Settings › Models › Reasoning instead. */

const FZR = {
  /** A write is in flight. */
  busy: false,
  /** The last write's sentence (drawn with the restart line), or null. */
  msg: null,
  /** The last write's error, or null. */
  err: null,
};

/** The choices in the order the control draws them. */
const FZR_CHOICES = ['default', 'low', 'medium', 'high'];
const FZR_LEVELS = ['low', 'medium', 'high'];

function fzrEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** "Default", "Low", "Medium", "High". */
function fzrLabel(choice) {
  return choice === 'low' ? 'Low' : choice === 'medium' ? 'Medium' : choice === 'high' ? 'High' : 'Default';
}

/**
 * The level the config holds, as the control lights it. No key, or a value
 * this build does not know (a newer build's level, which the agent also reads
 * as unset), is "default".
 */
function fzrLevelOf(cfg) {
  const fz = (cfg && cfg.llm && cfg.llm.runMode && cfg.llm.runMode.fusion) || {};
  return FZR_LEVELS.includes(fz.workerReasoning) ? fz.workerReasoning : 'default';
}

/** A typed `/runmode reasoning <x>` argument, or null when it is none of the choices. */
function fzrParseChoice(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return FZR_CHOICES.includes(v) ? v : null;
}

/**
 * The worker leg's provider: its kind and the model the workers run. A leg
 * with no provider row is the local one (fzLegIsLocal's rule).
 */
function fzrWorkerLeg(cfg, workerProviderId, workerModel) {
  const providers = (cfg && cfg.llm && Array.isArray(cfg.llm.providers)) ? cfg.llm.providers : [];
  const row = providers.find((p) => p && p.id === workerProviderId) || null;
  return {kind: row ? String(row.kind || '') : 'llama-server', model: workerModel || null};
}

/** What the level does on this worker provider, in one or two sentences. */
function fzrLegSentence(leg) {
  switch (leg && leg.kind) {
    case 'llama-server':
      return 'Local llama.cpp workers ignore this level. Their thinking is set in Settings › Models › Reasoning (Thinking and Thinking budget).';
    case 'openrouter':
      return 'Sent to OpenRouter as reasoning.effort with every worker request.';
    case 'openai-compatible':
    case 'qwen-openai-compatible':
      return 'Sent as reasoning_effort with every worker request.';
    case 'gemini':
      return 'Sent only to Gemini models that think (2.5 and 3). Other Gemini models get no level.';
    case 'aimlapi':
      return 'Sent only to OpenAI reasoning models on AI/ML API. Other models there get no level.';
    default:
      return 'This worker provider takes no reasoning level, so nothing is sent.';
  }
}

/** The help line under the control. */
function fzrHelpLine(leg) {
  return fzrLegSentence(leg) + ' Default leaves the provider its own level. Fusion workers only: the planner is not affected.';
}

/** The sentence a write leaves, before the restart line. */
function fzrSavedLine(choice, changed) {
  const label = fzrLabel(choice);
  if (!changed) return 'Worker reasoning is already ' + label + '.';
  return choice === 'default' ? 'Worker reasoning: Default (each provider’s own level).' : 'Worker reasoning: ' + label + '.';
}

/** The control row, as HTML. `level` is fzrLevelOf; `busy` disables the buttons. */
function fzrRowHTML(level, leg, busy) {
  return '<div class="llm-workers fzr-row">'
    + '<span class="tk-help"><b>Worker reasoning.</b> ' + fzrEsc(fzrHelpLine(leg)) + '</span>'
    + '<span class="tk-seg llm-workerseg" role="group" aria-label="Worker reasoning">'
    + FZR_CHOICES.map((c) => '<button class="' + (c === level ? 'on' : '') + '" data-act="runmode:reasoning:' + c + '"'
      + ' aria-pressed="' + (c === level) + '"' + (busy ? ' disabled' : '') + '>' + fzrLabel(c) + '</button>').join('')
    + '</span></div>';
}

/* ---------------- the browser half ---------------- */

/** Settings › Models' row under the worker count; `rm` is the resolved run mode. */
function fzrSettingsHTML(rm) {
  const cfg = typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null;
  const leg = fzrWorkerLeg(cfg, rm && rm.workerProviderId, rm && rm.workerModel);
  return fzrRowHTML(fzrLevelOf(cfg), leg, FZR.busy)
    + (FZR.err ? '<div class="tk-notice tk-notice--red">' + (typeof ic === 'function' ? ic('alert') : '') + '<span class="grow">' + fzrEsc(FZR.err) + '</span></div>'
      : FZR.msg && typeof restartLine === 'function' ? restartLine(FZR.msg) : '');
}

function fzrRepaint() {
  if (typeof S !== 'undefined' && S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'llm'
    && typeof llmRepaint === 'function') llmRepaint();
  else if (typeof render === 'function') render();
}

/**
 * Write a choice: the Settings buttons, and `/runmode reasoning <x>`
 * (`fromSlash`: its outcome is also a line in the chat).
 */
async function fzrSet(raw, fromSlash) {
  const choice = fzrParseChoice(raw);
  if (choice === null || FZR.busy) return {ok: false};
  if (typeof BR === 'undefined' || !BR || typeof BR.fusionWorkerReasoning !== 'function') {
    FZR.err = 'This build cannot set the worker reasoning level.';
    fzrRepaint();
    return {ok: false};
  }
  FZR.busy = true; FZR.msg = null; FZR.err = null;
  fzrRepaint();
  const res = await Promise.resolve(BR.fusionWorkerReasoning(choice))
    .catch((err) => ({ok: false, error: String((err && err.message) || err)}));
  FZR.busy = false;
  let line;
  if (!res || res.ok !== true) {
    FZR.err = 'Worker reasoning was not saved: ' + ((res && (res.refusal || res.error)) || 'unknown error');
    line = FZR.err;
  } else {
    if (res.changed && typeof refreshLiveConfig === 'function') await refreshLiveConfig();
    line = fzrSavedLine(choice, !!res.changed);
    // Unchanged: nothing to restart for.
    FZR.msg = res.changed ? line : null;
    if (res.changed) line += ' It applies to the running agent after Restart Agent Runtime.';
  }
  if (fromSlash && typeof S !== 'undefined' && typeof nid === 'function') {
    S.log.push({id: nid(), k: 'system', note: true, text: fzrEsc(line)});
  }
  fzrRepaint();
  return res;
}

if (typeof module !== 'undefined') {
  module.exports = {
    FZR, FZR_CHOICES, fzrLabel, fzrLevelOf, fzrParseChoice, fzrWorkerLeg, fzrLegSentence, fzrHelpLine,
    fzrSavedLine, fzrRowHTML,
  };
}
