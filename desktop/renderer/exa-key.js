/* ATO-328: web search asks for an Exa key.

   When `os.web.search` ran without a key and could not lean on the keyless
   Exa searches (they ran out, the search sites were unreachable, or there
   is no key), the agent says so on the call's `event: tool_result` frame
   (ATO-197): a top-level `key_required` = {provider:'exa', reason,
   getKeyUrl, envVar}. It can come with status "ok" (Exa was parked and
   DuckDuckGo answered) and it repeats on every search while Exa is parked,
   so the window shows one card per conversation, under the newest call
   that carried it, where the key can be pasted; Settings › General has the
   same field. The session store does not keep the field, so a reopened
   chat has no card.

   Shared by the renderer and Node checks: what the window reads from a
   result, which call the one card hangs under, and the markup. No IPC, no
   storage: the key itself never passes through here, and nothing here puts
   it into the markup (the input is emitted empty and refilled by the
   renderer from memory after a repaint). A result without the field changes
   nothing. */

const EXA_KEY_ENV = 'EXA_API_KEY';
const EXA_KEY_URL = 'https://dashboard.exa.ai/api-keys';
/* One plain line per reason. An unknown reason reads as `missing`. */
const EXA_KEY_REASONS = {
  rate_limited: 'The free web searches ran out for now. A free Exa key lifts the limit.',
  unreachable: 'The search sites could not be reached from this network. An Exa key may get through, if Exa itself is reachable.',
  missing: 'There is no Exa key yet, so web search cannot use Exa.',
};

/* The Exa sign-up page the agent named, or ours when it named something
   else: the button opens it in the system browser, so only an https page on
   exa.ai is taken from a tool result. */
function exaKeyUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol === 'https:' && (u.hostname === 'exa.ai' || u.hostname.endsWith('.exa.ai'))) return u.href;
  } catch (e) { /* not a URL */ }
  return EXA_KEY_URL;
}

/* `key_required` off a `tool_result` frame's payload. Null when it is
   absent (an agent without it, a search that did not ask) or is not about
   Exa: then nothing changes. */
function exaKeyRequired(src) {
  if (!src || typeof src !== 'object') return null;
  const k = src.key_required;
  if (!k || typeof k !== 'object' || k.provider !== 'exa') return null;
  const reason = Object.prototype.hasOwnProperty.call(EXA_KEY_REASONS, k.reason) ? k.reason : 'missing';
  return {reason, getKeyUrl: exaKeyUrl(k.getKeyUrl)};
}

/* The one call the card hangs under: the newest in the transcript that asked
   for a key. One card per conversation, never one per search. */
function exaKeyHost(log) {
  const rows = Array.isArray(log) ? log : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    if (m && m.k === 'tool' && m.keyReq) return m.id;
  }
  return null;
}

/* A key as pasted: '' when nothing was, null when it cannot be a key
   (spaces or line breaks inside, too short or too long), else the key. The
   same rule main applies before it writes (agent-cli.ts exaKeyValueError). */
function exaKeyClean(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  return /^[\x21-\x7e]{8,256}$/.test(v) ? v : null;
}

function exaKeyLinkHTML(url, h, cls) {
  return '<button class="' + cls + '" data-url="' + h.esc(url) + '">' + (cls.indexOf('btn') === 0 ? h.ic('globe') : '') + 'Get a free Exa key</button>';
}
function exaKeyInputHTML(place, st, h) {
  return '<label class="tk-inpwrap exak-inp' + (st.error ? ' is-error' : '') + '">' + h.ic('key')
    + '<input type="password" data-exa-key="' + place + '" autocomplete="off" spellcheck="false"'
    + ' placeholder="Paste your Exa API key" aria-label="Exa API key"' + (st.saving ? ' disabled' : '') + '></label>'
    + (st.error ? '<p class="tk-help tk-help--err">' + h.esc(st.error) + '</p>' : '');
}
/* After a save: the agent reads the key when it starts, so a restart is owed
   until a new agent is up. Restarting stops every running reply, so the
   button waits for them. */
function exaKeyRestartHTML(st, h) {
  if (!st.restartOwed) return '';
  return st.busy
    ? '<p class="exak-sub">Restart the agent when the running reply is done.</p>'
    : '<div class="exak-acts"><button class="btn btn-t sm" data-act="agent:restart">' + h.ic('refresh') + 'Restart Agent Runtime</button></div>';
}

/* The card under the call. `st`: {has, saving, error, note, saved,
   restartOwed, busy}; `h`: the renderer's {esc, ic}. */
function exaKeyCardHTML(req, st, h) {
  if (st.saved) {
    return '<div class="tk-card pad exak" data-exa-card="saved">'
      + '<div class="exak-head">' + h.ic('check') + '<b>Exa key saved</b></div>'
      + '<p>' + (st.restartOwed ? 'Web search will use it once the agent restarts.' : 'Web search uses it now.') + '</p>'
      + exaKeyRestartHTML(st, h)
      + '</div>';
  }
  return '<div class="tk-card pad exak" data-exa-card="ask" data-exa-reason="' + h.esc(req.reason) + '">'
    + '<div class="exak-head">' + h.ic('search') + '<b>Web search needs an Exa key</b></div>'
    + '<p>' + h.esc(EXA_KEY_REASONS[req.reason] || EXA_KEY_REASONS.missing) + '</p>'
    + (st.has ? '<p class="exak-sub">A key is already saved. A new one replaces it.</p>' : '')
    + exaKeyInputHTML('chat', st, h)
    + (st.note ? '<p class="exak-sub">' + h.esc(st.note) + '</p>' : '')
    + '<div class="exak-acts">' + exaKeyLinkHTML(req.getKeyUrl, h, 'btn btn-s sm')
      + '<span class="sd-grow"></span>' + (st.saving ? '<span class="exak-sub">Saving…</span>' : '')
      + '<button class="btn btn-p sm" data-act="exakey:save:chat"' + (st.saving ? ' disabled' : '') + '>Save</button></div>'
    + '</div>';
}

/* Settings › General: the same field. An empty Save keeps the saved key.
   `st`: {has, saving, error, note, restartOwed, busy}. */
function exaKeySettingsRowHTML(st, h) {
  const status = st.has === true ? 'A key is saved.' : st.has === false ? 'No key saved.' : '';
  return '<div class="tk-setrow exak-row">'
    + '<div class="body"><div class="t">Web search key (Exa)</div>'
      + '<div class="d">' + (status ? h.esc(status) + ' ' : '')
        + 'Without a key, web search uses the free Exa searches, which run out quickly. '
        + exaKeyLinkHTML(EXA_KEY_URL, h, 'set-link') + '</div>'
      + exaKeyInputHTML('settings', st, h)
      + (st.note ? '<p class="tk-help">' + h.esc(st.note) + '</p>' : '')
      + exaKeyRestartHTML(st, h)
    + '</div>'
    + '<button class="btn btn-s sm" data-act="exakey:save:settings"' + (st.saving ? ' disabled' : '') + '>Save</button>'
    + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {EXA_KEY_ENV, EXA_KEY_URL, EXA_KEY_REASONS, exaKeyUrl, exaKeyRequired, exaKeyHost, exaKeyClean,
    exaKeyCardHTML, exaKeySettingsRowHTML};
}
