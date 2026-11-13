/* ATO-445: Settings › Tasks › Webhooks. The agent's inbound webhook routes
   (GET /api/webhooks): each with its address, its signature preset and a
   Delete that asks first (DELETE /api/webhooks/:name), and a form that adds
   one (POST /api/webhooks) for GitHub, Stripe, Standard Webhooks or a plain
   shared secret, with the prompt each event becomes. The secret is shown
   once, right after the route is made, with a Copy button; it is dropped
   from memory when the box is closed and never read back.
   An agent from before the routes says "Update the agent to manage
   webhooks" and changes nothing.
   Outside services never post to the agent's own address: it stays on
   127.0.0.1 behind this app's key. They reach a route only through the
   webhook tunnel listener (`atag serve --tunnel`, ATO-625), signed with
   the route's own secret. When the agent reports the tunnel up
   (GET /api/webhooks `tunnel.publicUrl`, or a route's `publicUrl`) that
   public address is the one shown and copied; otherwise the pane says how
   to turn the tunnel on.
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/webhooks.test.mjs). No DOM, no IPC of its own. */

const WHK_OLD_AGENT = 'Update the agent to manage webhooks.';
const WHK_EMPTY = 'No webhooks yet. Add one and each event becomes a task for the agent.';
const WHK_TUNNEL_HOWTO = 'Outside services (GitHub, Stripe) reach these routes only through the webhook tunnel: start the agent with atag serve --tunnel (cloudflared must be installed). The public address then shows here. Each route is checked with its own secret.';
const WHK_TUNNEL_UP = 'Outside services post to the public address through the webhook tunnel, which serves only webhook routes. Each route is checked with its own secret.';

/* [preset, label, where the secret goes, the starting prompt, secret field: 'none' | 'optional' | 'required'] */
const WHK_PRESETS = [
  ['github', 'GitHub', 'In the repository: Settings › Webhooks › Add webhook. Content type application/json, then paste the secret shown after you save here.',
    'GitHub sent a {{body.action}} event for {{body.repository.full_name}}. Summarise it and say if anything needs doing.', 'none'],
  ['stripe', 'Stripe', 'Stripe makes the signing secret: paste the whsec_… value it shows for the endpoint.',
    'Stripe sent a {{body.type}} event ({{body.id}}). Summarise it and say if anything needs doing.', 'required'],
  ['standard', 'Standard Webhooks', 'For senders that sign with Standard Webhooks (Svix uses it too). Paste the sender’s whsec_… secret, or leave it empty to make one here.',
    'A webhook event arrived: {{body.type}}. Summarise it and say if anything needs doing.', 'optional'],
  ['header', 'Shared secret', 'The sender puts the secret in an x-webhook-secret header.',
    'A webhook event arrived: {{body}}', 'none'],
];

function whkPreset(id) {
  return WHK_PRESETS.find((p) => p[0] === id) || WHK_PRESETS[WHK_PRESETS.length - 1];
}
function whkPresetLabel(id) { return whkPreset(id)[1]; }

function whkNameOk(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name) && name !== '__proto__';
}

/** A free name for a new route: `github`, then `github-2`, … */
function whkSuggestName(preset, taken) {
  const used = new Set((taken || []).map((w) => w && w.name));
  const base = whkPreset(preset)[0] === 'header' ? 'webhook' : whkPreset(preset)[0];
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!used.has(base + '-' + i)) return base + '-' + i;
  return base + '-' + Date.now();
}

/** The full address a sender posts to: the agent's base and the route's path. */
function whkUrl(baseUrl, path) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return b ? b + path : path;
}

/** The tunnel as the agent reports it, or null (an agent without the tunnel, or a value that is not an https origin). */
function whkTunnel(v) {
  if (!v || typeof v !== 'object') return null;
  const state = ['off', 'starting', 'up', 'failed'].includes(v.state) ? v.state : 'off';
  const publicUrl = typeof v.publicUrl === 'string' && /^https:\/\/[^\s/]+\/?$/.test(v.publicUrl) ? v.publicUrl.replace(/\/+$/, '') : null;
  return {state, publicUrl: state === 'up' ? publicUrl : null, error: typeof v.error === 'string' ? v.error : null};
}

/** The public address an outside sender posts to, or '' while there is none:
    the route's own publicUrl, else the tunnel origin plus the route's path.
    A route without a secret gets none: the tunnel turns it away. */
function whkPublicUrl(st, w) {
  if (!w || w.hasSecret === false) return '';
  if (typeof w.publicUrl === 'string' && /^https:\/\//.test(w.publicUrl)) return w.publicUrl;
  const t = st && st.data && st.data.tunnel;
  return t && t.publicUrl && typeof w.path === 'string' ? t.publicUrl + w.path : '';
}

/** What is wrong with the form, in words, or '' when it can be sent. */
function whkFormError(form, taken) {
  const f = form || {};
  if (!whkNameOk(f.name)) return 'The name can use letters, digits, - and _ (up to 64).';
  if ((taken || []).some((w) => w && w.name === f.name)) return 'A webhook named “' + f.name + '” already exists.';
  if (!String(f.template || '').trim()) return 'Write what the agent should do with each event.';
  if (whkPreset(f.verify)[4] === 'required' && !String(f.secret || '').trim()) return 'Paste the signing secret from Stripe.';
  return '';
}

function whkList(v) {
  return Array.isArray(v) ? v.filter((w) => w && typeof w === 'object' && whkNameOk(w.name) && typeof w.path === 'string') : [];
}

/* `api.read()`         → {supported:false} | {supported:true, ok:true, data, baseUrl, remote} | {supported:true, ok:false, error}
   `api.create(body)`   → {supported:false} | {ok:true, data:{webhook, secret}} | {ok:false, conflict?, error}
   `api.remove(name)`   → {supported:false} | {ok:true} | {ok:false, notFound?, error} */
function createWebhooks(api) {
  const st = {supported: null, loading: false, error: null, data: null, baseUrl: '', remote: false, serial: 0,
    busy: new Set(), confirm: null, form: null, formError: '', creating: false, created: null};
  const freshForm = (verify) => {
    const v = whkPreset(verify || 'github')[0];
    return {verify: v, name: whkSuggestName(v, st.data && st.data.webhooks), template: whkPreset(v)[3], secret: '', touchedName: false, touchedTemplate: false};
  };
  return {
    state: st,
    async load() {
      const mine = ++st.serial;
      st.loading = true;
      const res = await Promise.resolve().then(() => api.read()).catch((error) => ({supported: true, ok: false, error: String(error)}));
      if (mine !== st.serial) return st;
      st.loading = false;
      if (!res || res.supported === false) { st.supported = false; st.data = null; st.error = null; return st; }
      st.supported = true;
      if (!res.ok) { st.error = res.error || 'could not read the webhooks'; return st; }
      const d = res.data || {};
      st.error = null;
      st.baseUrl = typeof res.baseUrl === 'string' ? res.baseUrl : '';
      st.remote = !!res.remote;
      st.data = {webhooks: whkList(d.webhooks), tasksEnabled: d.tasksEnabled !== false, tunnel: whkTunnel(d.tunnel)};
      return st;
    },
    /* Another agent is on the wire: start over, and forget a secret still on screen. */
    reset() {
      st.supported = null; st.serial++; st.loading = false; st.error = null; st.data = null; st.busy.clear();
      st.confirm = null; st.form = null; st.formError = ''; st.creating = false; st.created = null;
    },
    openForm(verify) { st.form = freshForm(verify); st.formError = ''; st.created = null; },
    closeForm() { st.form = null; st.formError = ''; },
    /* A preset change swaps the name and prompt the person has not typed over. */
    setPreset(verify) {
      if (!st.form) return;
      const v = whkPreset(verify)[0];
      const next = freshForm(v);
      st.form.verify = v;
      if (!st.form.touchedName) st.form.name = next.name;
      if (!st.form.touchedTemplate) st.form.template = next.template;
      if (whkPreset(v)[4] === 'none') st.form.secret = '';
      st.formError = '';
    },
    /* One keystroke into the form: field is name | template | secret. */
    type(field, value) {
      if (!st.form || !['name', 'template', 'secret'].includes(field)) return;
      st.form[field] = String(value);
      if (field === 'name') st.form.touchedName = true;
      if (field === 'template') st.form.touchedTemplate = true;
    },
    async create() {
      if (!st.form || st.creating) return {ok: false};
      const f = st.form;
      const taken = st.data ? st.data.webhooks : [];
      const err = whkFormError(f, taken);
      if (err) { st.formError = err; return {ok: false, error: err}; }
      st.creating = true; st.formError = '';
      const body = {name: f.name, verify: f.verify, userMessageTemplate: f.template.trim(),
        ...(whkPreset(f.verify)[4] !== 'none' && f.secret.trim() ? {secret: f.secret.trim()} : {})};
      const res = await Promise.resolve().then(() => api.create(body)).catch((error) => ({ok: false, error: String(error)}));
      st.creating = false;
      if (!res || res.supported === false) { st.supported = false; st.data = null; st.form = null; return {ok: false, unsupported: true}; }
      if (!res.ok) { st.formError = (res.conflict ? '' : 'Couldn’t add the webhook: ') + (res.error || 'unknown error'); return res; }
      const d = res.data || {};
      const hook = d.webhook && whkNameOk(d.webhook.name) ? d.webhook : {name: f.name, path: '/api/webhooks/' + f.name, verify: f.verify};
      if (st.data && !st.data.webhooks.some((w) => w.name === hook.name)) st.data.webhooks.push(hook);
      const path = hook.path || ('/api/webhooks/' + hook.name);
      st.created = {name: hook.name, verify: hook.verify || f.verify, path,
        url: whkPublicUrl(st, {...hook, path, hasSecret: hook.hasSecret !== false}),
        secret: typeof d.secret === 'string' ? d.secret : ''};
      st.form = null;
      return {ok: true};
    },
    /* The secret box closes: the secret is not kept anywhere on this side. */
    dismissCreated() { st.created = null; },
    askDelete(name) { if (st.data && st.data.webhooks.some((w) => w.name === name)) st.confirm = name; },
    cancelDelete() { st.confirm = null; },
    /* Delete after the confirm. One already gone (404) is gone here too. */
    async remove(name) {
      if (!name || st.confirm !== name || st.busy.has(name) || !st.data) return {ok: false};
      st.busy.add(name);
      const res = await Promise.resolve().then(() => api.remove(name)).catch((error) => ({ok: false, error: String(error)}));
      st.busy.delete(name);
      st.confirm = null;
      if (!res || res.supported === false) { st.supported = false; st.data = null; return {ok: false, unsupported: true}; }
      if (res.ok || res.notFound) {
        if (st.data) st.data.webhooks = st.data.webhooks.filter((w) => w.name !== name);
        if (st.created && st.created.name === name) st.created = null;
        st.error = null;
        return {ok: true};
      }
      st.error = 'Couldn’t delete the webhook: ' + (res.error || 'unknown error');
      return res;
    },
  };
}

/** The pane. deps: {esc}. Inputs carry ids so a repaint keeps focus and caret. */
function webhooksHTML(st, deps) {
  const {esc} = deps;
  const head = (btn) => '<div class="tk-sh set-whk-sh"><span>Webhooks</span>' + (btn || '') + '</div>';
  const note = (text, cls) => '<p class="set-cap set-privnote' + (cls ? ' ' + cls : '') + '">' + text + '</p>';
  if (st.supported === false) return '<div class="set-pane set-whk">' + head() + note(esc(WHK_OLD_AGENT), 'set-whk-old') + '</div>';
  const err = st.error ? '<div class="tk-help tk-help--warn set-privnote set-whk-err">' + esc(st.error)
    + ' <button class="set-link" data-act="whk:reload">Try again</button></div>' : '';
  if (!st.data) {
    return '<div class="set-pane set-whk">' + head() + (st.error ? err : note('<span class="tk-spin"></span> Loading webhooks…', 'set-whk-loading')) + '</div>';
  }
  const newBtn = st.form ? '' : '<button class="btn btn-p sm" data-act="whk:new" title="Add a webhook">New webhook</button>';
  const t = st.data.tunnel;
  const reach = t && t.state === 'up' && t.publicUrl ? WHK_TUNNEL_UP
    : t && t.state === 'starting' ? 'The webhook tunnel is starting; the public address shows here when it is up.'
    : t && t.state === 'failed' ? 'The webhook tunnel stopped' + (t.error ? ' (' + t.error + ')' : '') + '. ' + WHK_TUNNEL_HOWTO
    : WHK_TUNNEL_HOWTO;
  const parts = [head(newBtn), note(esc('Each event a sender posts becomes a task with your prompt. ' + reach), 'set-whk-reach')];
  if (!st.data.tasksEnabled) parts.push('<div class="tk-help tk-help--warn set-privnote set-whk-tasksoff">Tasks are off in the agent’s config, so webhooks are turned away until they are on.</div>');

  if (st.created) {
    const c = st.created;
    parts.push('<div class="tk-help set-whk-created" role="status">'
      + '<div class="t">“' + esc(c.name) + '” is ready. Copy the secret now: it is not shown again.</div>'
      + (c.url
        ? '<div class="set-whk-kv"><span>Address</span><code>' + esc(c.url) + '</code>'
          + '<button class="btn btn-s xs" data-act="whk:copyurl:' + esc(c.name) + '">Copy</button></div>'
        : '<div class="set-whk-kv"><span>Path</span><code>' + esc(c.path) + '</code></div>'
          + '<div class="d">The public address shows here once the webhook tunnel is up.</div>')
      + (c.secret ? '<div class="set-whk-kv"><span>Secret</span><code class="set-whk-secret">' + esc(c.secret) + '</code>'
        + '<button class="btn btn-s xs" data-act="whk:copysecret">Copy</button></div>' : '')
      + '<div class="d">' + esc(whkPreset(c.verify)[2]) + '</div>'
      + '<button class="btn btn-p sm" data-act="whk:done">Done</button>'
      + '</div>');
  }

  if (st.form) {
    const f = st.form;
    const p = whkPreset(f.verify);
    const seg = '<div class="tk-seg set-seg" role="radiogroup" aria-label="Sender">'
      + WHK_PRESETS.map((x) => '<button class="' + (x[0] === f.verify ? 'on' : '') + '" role="radio" aria-checked="' + (x[0] === f.verify) + '" data-act="whk:preset:' + x[0] + '">' + esc(x[1]) + '</button>').join('')
      + '</div>';
    const secret = p[4] === 'none' ? ''
      : '<label class="set-whk-field"><span>Signing secret' + (p[4] === 'optional' ? ' (optional)' : '') + '</span>'
        + '<input id="whk-secret" data-whk-field="secret" value="' + esc(f.secret) + '" placeholder="whsec_…" autocomplete="off" spellcheck="false"></label>';
    parts.push('<div class="set-whk-form">'
      + seg
      + '<p class="set-cap">' + esc(p[2]) + '</p>'
      + '<label class="set-whk-field"><span>Name</span><input id="whk-name" data-whk-field="name" value="' + esc(f.name) + '" autocomplete="off" spellcheck="false"></label>'
      + secret
      + '<label class="set-whk-field"><span>Prompt for each event</span><textarea id="whk-template" data-whk-field="template" rows="3" spellcheck="false">' + esc(f.template) + '</textarea></label>'
      + '<p class="set-cap">{{body.field}} puts a value from the event in, for example {{body.action}}; {{body}} puts the whole event.</p>'
      + (st.formError ? '<div class="tk-help tk-help--warn set-whk-formerr">' + esc(st.formError) + '</div>' : '')
      + '<div class="set-tbacts"><button class="btn btn-g sm" data-act="whk:cancel">Cancel</button>'
        + '<button class="btn btn-p sm" data-act="whk:create"' + (st.creating ? ' disabled' : '') + '>' + (st.creating ? 'Adding…' : 'Add webhook') + '</button></div>'
      + '</div>');
  }

  const rows = st.data.webhooks.map((w) => {
    const url = whkPublicUrl(st, w);
    const asking = st.confirm === w.name;
    const busy = st.busy.has(w.name);
    const acts = asking
      ? '<span class="set-whk-ask">Delete “' + esc(w.name) + '”?</span>'
        + '<button class="btn btn-g sm" data-act="whk:keep">Keep</button>'
        + '<button class="btn btn-danger sm" data-act="whk:delyes:' + esc(w.name) + '"' + (busy ? ' disabled' : '') + '>Delete</button>'
      : (url ? '<button class="btn btn-s sm" data-act="whk:copyurl:' + esc(w.name) + '" title="Copy the public address">Copy address</button>' : '')
        + '<button class="btn btn-s sm" data-act="whk:del:' + esc(w.name) + '" title="Delete this webhook">Delete</button>';
    const bits = [esc(whkPresetLabel(w.verify))];
    if (w.hasSecret === false) bits.push('no secret, so the tunnel turns it away');
    if (w.live === false) bits.push('starts after the agent restarts');
    return '<div class="tk-setrow set-whk-row" data-whk="' + esc(w.name) + '">'
      + '<div class="body"><div class="t">' + esc(w.name) + ' <span class="d">' + bits.join(' · ') + '</span></div>'
        + '<div class="d"><code>' + esc(url || w.path) + '</code></div></div>'
      + acts + '</div>';
  });
  if (!rows.length && !st.form && !st.created) parts.push(note(esc(WHK_EMPTY), 'set-whk-empty'));
  else if (rows.length) parts.push('<div class="tk-list set-setlist set-whks">' + rows.join('') + '</div>');
  parts.push(err);
  return '<div class="set-pane set-whk">' + parts.join('') + '</div>';
}

if (typeof module !== 'undefined') module.exports = {WHK_OLD_AGENT, WHK_EMPTY, WHK_TUNNEL_HOWTO, WHK_TUNNEL_UP, WHK_PRESETS, whkPreset, whkPresetLabel, whkNameOk, whkSuggestName, whkUrl, whkTunnel, whkPublicUrl, whkFormError, createWebhooks, webhooksHTML};
