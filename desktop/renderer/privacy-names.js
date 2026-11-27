/* ATO-2527: Settings › Privacy › Privacy Shield › "Names, addresses and
   organisations". A model on this computer finds them and they are masked
   too. The switch and the model choice belong to the agent (GET/POST
   /api/privacy-shield, `localNames`); privacy-shield.js keeps the state,
   this file only words it and draws the row.
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/privacy-names.test.mjs). No DOM, no IPC. */

const NAMES_OLD_AGENT = 'Update the agent to hide names, addresses and organisations.';
const NAMES_REGEX_ONLY = 'only emails, phone numbers, cards and keys are hidden';
const NAMES_STATES = ['off', 'ready', 'no-local-model', 'provider-not-shielded'];
/* The active chat provider is a ChatGPT sign-in or a Claude Code / Codex CLI: no Privacy Shield there (ATO-2808). */
const NAMES_NOT_SHIELDED = 'The current chat model (a ChatGPT sign-in, or Claude Code or Codex) isn’t covered by Privacy Shield, so nothing is hidden from it.';

/** "qwen3-4b", or the provider id when the entry names no model, or null. */
function namesModelLabel(model) {
  if (!model || typeof model.provider !== 'string') return null;
  return typeof model.model === 'string' && model.model ? model.model : model.provider;
}

/** The agent's `localNames`, checked; null for an agent without it or a bad shape. */
function readNamesStatus(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean') return null;
  if (!NAMES_STATES.includes(raw.state)) return null;
  const model = raw.model && typeof raw.model.provider === 'string'
    ? {provider: raw.model.provider, model: typeof raw.model.model === 'string' ? raw.model.model : null} : null;
  return {enabled: raw.enabled, state: raw.state, model};
}

/** The line under the switch: which model reads the text, and what happens without one. */
function namesHint(names, shieldOn) {
  if (names.state === 'provider-not-shielded') return NAMES_NOT_SHIELDED;
  const label = namesModelLabel(names.model);
  if (names.state === 'ready' && label) {
    return (shieldOn ? '' : 'Works when Privacy Shield is on. ')
      + 'Uses ' + label + ' on this computer to find them before a request goes to a cloud model. If that model isn’t running, ' + NAMES_REGEX_ONLY + '.';
  }
  if (names.state === 'no-local-model') {
    return 'Needs a model running on this computer: the built-in local model, or LM Studio or Ollama. None is set up, so ' + NAMES_REGEX_ONLY + '.';
  }
  if (label) return 'When on, ' + label + ' on this computer finds them. The text is never sent anywhere else for this.';
  return 'Needs a model running on this computer: the built-in local model, or LM Studio or Ollama.';
}

/** The toast after the names switch: [title, detail]. Claims hiding only when it will happen, like namesHint. */
function namesToast(names, shieldOn) {
  if (!names || !names.enabled) return ['Hiding names off', 'Names go to cloud models as written'];
  if (names.state === 'provider-not-shielded') return ['Hiding names on', NAMES_NOT_SHIELDED];
  if (!shieldOn) return ['Hiding names on', 'Works when Privacy Shield is on'];
  if (names.state !== 'ready' || !namesModelLabel(names.model)) {
    return ['Hiding names on', 'Needs a model on this computer. Until then ' + NAMES_REGEX_ONLY];
  }
  return ['Hiding names on', 'A model on this computer hides names, addresses and organisations'];
}

/** The names row, under the Privacy Shield row. deps: {esc}. Empty until the shield row knows the agent. */
function privacyNamesHTML(st, deps) {
  const {esc} = deps;
  if (st.supported !== true) return '';
  const names = st.names;
  const old = names === null;
  const pending = names === undefined && !st.error;
  const known = !!names;
  const on = known && names.enabled;
  let help = '';
  if (old) help = '<div class="tk-help set-names-old">' + esc(NAMES_OLD_AGENT) + '</div>';
  else if (known) {
    help = '<div class="tk-help set-names-hint' + (names.state === 'no-local-model' || names.state === 'provider-not-shielded' ? ' tk-help--warn' : '') + '">' + esc(namesHint(names, st.enabled === true));
    if (names.state === 'no-local-model' || (!names.model && names.state === 'off')) {
      help += ' <button class="set-link" data-act="settings:llm:local">Set up a local model</button>';
    }
    help += '</div>';
  }
  if (st.namesError) help += '<div class="tk-help tk-help--warn set-names-err">' + esc(st.namesError)
    + ' <button class="set-link" data-act="shield:reload">Try again</button></div>';
  const busy = st.namesBusy === true;
  return '<div class="tk-setrow set-names">'
    + '<div class="body"><div class="t">Names, addresses and organisations</div>'
      + '<div class="d">When on, people’s names, street addresses and organisations are hidden too, found by a model on this computer.</div>'
      + help
    + '</div>'
    + (pending || busy ? '<span class="set-state" aria-hidden="true"><span class="tk-spin"></span></span>' : '')
    + '<button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="Hide names, addresses and organisations" data-act="shield:names"'
      + (!known || busy ? ' disabled' : '')
      + ' title="' + esc(old ? NAMES_OLD_AGENT : 'Turn hiding names ' + (on ? 'off' : 'on')) + '"></button>'
    + '</div>';
}

if (typeof module !== 'undefined') module.exports = {NAMES_OLD_AGENT, namesModelLabel, readNamesStatus, namesHint, namesToast, privacyNamesHTML};
