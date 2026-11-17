/* ---------------- ATO-1492: an MCP server asks the person ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/mcp-elicitation.test.mjs); the renderer half reads
   renderer.js globals at call time, as deeplink.js does.

   An MCP server can stop in the middle of a tool call and ask the person:
   "Delete the draft?", "Which account?", a small form. The agent sends it on
   /api/events as `mcp_elicitation` (this window opts in with ?elicitation=1)
   and main hands it here. This draws ONE sheet at a time: which server asks,
   its message, the fields. Nothing is sent until a button is pressed.

   Rules (Nadya, 17.11):
   - Every question goes through this sheet, a plain "confirm?" with no fields
     too. Never through the approval card: approvals can be answered by the
     approval ladder on its own, a server's question only by a person.
   - A field marked `sensitive` (password, token, PIN…) is a password box, and
     its value is never kept after the sheet closes.
   - Decline = "no"; closing the sheet (Escape, the scrim, ×) = cancel.
   - An answer that does not fit the form comes back as an error and the
     sheet stays open. */

/** The title of the sheet. */
function mcpElicitTitle(q) {
  const server = q && q.server ? String(q.server) : 'An MCP server';
  return server + ' asks';
}

/** True for a plain "confirm?" question: no fields, just yes / no. */
function mcpElicitIsConfirm(q) {
  return !q || !Array.isArray(q.fields) || q.fields.length === 0;
}

/** The starting values of a form: each field's default, if it has one. */
function mcpElicitDefaults(fields) {
  const out = {};
  for (const f of fields || []) {
    if (f.default !== undefined) out[f.name] = Array.isArray(f.default) ? f.default.slice() : f.default;
    else if (f.kind === 'boolean') out[f.name] = false;
    else if (f.kind === 'multi_enum') out[f.name] = [];
  }
  return out;
}

/* Turn what the boxes hold into the answer the agent checks against the form:
   {ok:true, content} or {ok:false, error} naming the field (never its value).
   Empty optional fields are left out; numbers are numbers. */
function mcpElicitContent(fields, values) {
  const content = {};
  for (const f of fields || []) {
    const label = f.title || f.name;
    let v = values ? values[f.name] : undefined;
    if (f.kind === 'number') {
      if (v === undefined || v === null || String(v).trim() === '') v = undefined;
      else {
        const n = Number(String(v).trim());
        if (!Number.isFinite(n)) return {ok: false, error: label + ' must be a number'};
        if (f.integer && !Number.isInteger(n)) return {ok: false, error: label + ' must be a whole number'};
        v = n;
      }
    } else if (f.kind === 'string' || f.kind === 'enum') {
      if (v === undefined || v === null || String(v) === '') v = undefined;
      else v = String(v);
    } else if (f.kind === 'boolean') {
      v = !!v;
    } else if (f.kind === 'multi_enum') {
      v = Array.isArray(v) ? v.slice() : [];
      if (!v.length && !f.required) v = undefined;
    }
    if (v === undefined) {
      if (f.required) return {ok: false, error: label + ' is required'};
      continue;
    }
    content[f.name] = v;
  }
  return {ok: true, content};
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

/* `queue` holds the open questions in the order they came; `shown` is the id on
   screen; `values` what its boxes hold; `answered` ids this window already
   sent, so a replay (the stream reopens on page load) does not draw them again. */
const MCPEL = {queue: [], shown: null, values: {}, error: null, busy: false, answered: new Set(), armAt: 0, armTimer: null};

/* Like the link card: after the sheet's content changes, the buttons wait a
   moment, so a click already on its way cannot answer a question not yet read. */
const MCPEL_ARM_MS = 800;
const MCPEL_QUEUE_MAX = 20;

function mcpElicitWire() {
  if (!BR || !BR.onMcpElicitation) return;
  BR.onMcpElicitation((req) => mcpElicitAsked(req));
  if (BR.onMcpElicitationClosed) BR.onMcpElicitationClosed((ev) => mcpElicitClosed(ev));
}

function mcpElicitAsked(req) {
  if (!req || typeof req.id !== 'string' || !req.question) return;
  if (MCPEL.answered.has(req.id) || MCPEL.shown === req.id || MCPEL.queue.some((r) => r.id === req.id)) return;
  MCPEL.queue.push(req);
  if (MCPEL.queue.length > MCPEL_QUEUE_MAX) MCPEL.queue.shift();
  if (!MCPEL.shown) mcpElicitWhenClosed();
}

/** The server gave up, or it was answered elsewhere: take it down. */
function mcpElicitClosed(ev) {
  if (!ev || typeof ev.id !== 'string') return;
  MCPEL.queue = MCPEL.queue.filter((r) => r.id !== ev.id);
  if (MCPEL.shown === ev.id) {
    mcpElicitForget();
    if (S.overlay === 'mcpelicit') S.overlay = null;
    if (ev.reason === 'server_cancelled') toast('The MCP server stopped asking', 'Its question was closed.');
    render();
  }
}

function mcpElicitCurrent() {
  return MCPEL.shown ? MCPEL.queue.find((r) => r.id === MCPEL.shown) || null : null;
}

function mcpElicitForget() {
  if (MCPEL.shown) MCPEL.queue = MCPEL.queue.filter((r) => r.id !== MCPEL.shown);
  MCPEL.shown = null; MCPEL.values = {}; MCPEL.error = null; MCPEL.busy = false;
}

function mcpElicitArm() {
  MCPEL.armAt = Date.now() + MCPEL_ARM_MS;
  if (MCPEL.armTimer) clearTimeout(MCPEL.armTimer);
  MCPEL.armTimer = setTimeout(() => { MCPEL.armTimer = null; if (S.overlay === 'mcpelicit') render(); }, MCPEL_ARM_MS + 20);
}

/* Called from overlaysHTML when the sheet is not on screen. A sheet that was
   on screen and got closed without an answer (Escape, the scrim, ×) is a
   cancel. Then the next question, once nothing else is up. */
function mcpElicitWhenClosed() {
  if (MCPEL.shown && !MCPEL.busy) {
    const id = MCPEL.shown;
    mcpElicitForget();
    mcpElicitSend(id, 'cancel');
  }
  if (MCPEL.shown || !MCPEL.queue.length || S.overlay) return;
  setTimeout(() => {
    if (MCPEL.shown || !MCPEL.queue.length || S.overlay) return;
    const req = MCPEL.queue[0];
    MCPEL.shown = req.id; MCPEL.values = mcpElicitDefaults(req.question.fields); MCPEL.error = null;
    S.overlay = 'mcpelicit';
    S.settings = null;   // as the link card: the sheet is the one thing on screen
    mcpElicitArm();
    render();
  }, 0);
}

function mcpElicitFieldHTML(f, values) {
  const id = 'mcpel-' + f.name;
  const label = esc(f.title || f.name) + (f.required ? ' <span class="sd-cap">(required)</span>' : '');
  const hint = f.description ? '<span class="sd-cap">' + esc(f.description) + '</span>' : '';
  const v = values[f.name];
  const data = ' data-mcpel-field="' + esc(f.name) + '"';
  if (f.kind === 'boolean') {
    return '<label class="tk-field tkrow"><input type="checkbox" id="' + id + '"' + data + (v ? ' checked' : '') + '> <span class="tk-lbl">' + label + '</span>' + hint + '</label>';
  }
  if (f.kind === 'enum') {
    const opts = (f.options || []).map((o) => '<option value="' + esc(o.value) + '"' + (v === o.value ? ' selected' : '') + '>' + esc(o.label || o.value) + '</option>').join('');
    return '<label class="tk-field tkrow"><span class="tk-lbl">' + label + '</span>' + hint
      + '<select class="tk-inp" id="' + id + '"' + data + '>' + (f.required && v !== undefined ? '' : '<option value=""></option>') + opts + '</select></label>';
  }
  if (f.kind === 'multi_enum') {
    const picked = Array.isArray(v) ? v : [];
    const boxes = (f.options || []).map((o) => '<label class="tkrow"><input type="checkbox"' + data + ' data-mcpel-opt="' + esc(o.value) + '"'
      + (picked.includes(o.value) ? ' checked' : '') + '> ' + esc(o.label || o.value) + '</label>').join('');
    return '<div class="tk-field tkrow"><span class="tk-lbl">' + label + '</span>' + hint + boxes + '</div>';
  }
  const type = f.sensitive ? 'password' : f.kind === 'number' ? 'number' : f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : f.format === 'date' ? 'date' : 'text';
  return '<label class="tk-field tkrow"><span class="tk-lbl">' + label + '</span>' + hint
    + '<input class="tk-inp" type="' + type + '" id="' + id + '"' + data + ' autocomplete="off" spellcheck="false" value="' + esc(v == null ? '' : String(v)) + '"></label>';
}

function mcpElicitSheetHTML() {
  const req = mcpElicitCurrent();
  if (!req) return '';
  const q = req.question;
  const confirm = mcpElicitIsConfirm(q);
  let body = '<p class="sd-cap">An MCP server you added is asking you this in the middle of a task. The task waits for your answer.</p>'
    + '<p>' + esc(q.message || '') + '</p>';
  if (!confirm) body += '<div class="sd-form">' + q.fields.map((f) => mcpElicitFieldHTML(f, MCPEL.values)).join('') + '</div>';
  if (MCPEL.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(MCPEL.error) + '</span></div>';
  const armed = Date.now() >= MCPEL.armAt && !MCPEL.busy;
  const foot = '<span class="grow"></span>'
    + '<button class="btn btn-s sm" data-act="mcpelicit:decline"' + (armed ? '' : ' disabled') + '>Decline</button>'
    + '<button class="btn btn-p sm" data-act="mcpelicit:accept"' + (armed ? '' : ' disabled') + '>'
    + (MCPEL.busy ? '<span class="tk-spin"></span>' : '') + (confirm ? 'Confirm' : 'Send') + '</button>';
  return sheet(mcpElicitTitle(q), body, foot, 'sheet-mcpelicit');
}

/** The `input` listener: the boxes write MCPEL.values, so a repaint keeps them. */
function mcpElicitInput(e) {
  const t = e.target;
  const name = t && t.dataset ? t.dataset.mcpelField : undefined;
  if (name === undefined || !MCPEL.shown) return false;
  if (t.dataset.mcpelOpt !== undefined) {
    const list = Array.isArray(MCPEL.values[name]) ? MCPEL.values[name].slice() : [];
    const opt = t.dataset.mcpelOpt;
    const at = list.indexOf(opt);
    if (t.checked && at < 0) list.push(opt);
    if (!t.checked && at >= 0) list.splice(at, 1);
    MCPEL.values[name] = list;
  } else if (t.type === 'checkbox') {
    MCPEL.values[name] = !!t.checked;
  } else {
    MCPEL.values[name] = t.value;
  }
  return true;
}

async function mcpElicitSend(id, action, content) {
  MCPEL.answered.add(id);
  const res = await BR.mcpElicitationAnswer(id, action, content).catch((e) => ({ok: false, status: 0, error: String((e && e.message) || e)}));
  return res || {ok: false, status: 0, error: 'no answer'};
}

async function mcpElicitAnswer(action) {
  const req = mcpElicitCurrent();
  if (!req || MCPEL.busy || Date.now() < MCPEL.armAt || !BR || !BR.mcpElicitationAnswer) return;
  let content;
  if (action === 'accept') {
    const built = mcpElicitContent(req.question.fields, MCPEL.values);
    if (!built.ok) { MCPEL.error = built.error; render(); return; }
    content = built.content;
  }
  MCPEL.busy = true; MCPEL.error = null; render();
  const res = await mcpElicitSend(req.id, action, content);
  MCPEL.busy = false;
  if (MCPEL.shown !== req.id) return;   // closed by the server meanwhile
  if (res.ok || res.status === 404) {
    mcpElicitForget();
    if (S.overlay === 'mcpelicit') S.overlay = null;
    if (!res.ok) toast('The MCP server no longer waits for this', 'Its question was already closed.');
    render();
    return;
  }
  // 400: the answer does not fit; the question is still open there.
  if (res.status === 400) MCPEL.answered.delete(req.id);
  MCPEL.error = res.error || 'The answer was not accepted.';
  mcpElicitArm();
  render();
}

/** `mcpelicit:<verb>` from act(): accept / decline. Closing the sheet is the shared `close` (a cancel). */
function mcpElicitAct(v) {
  if (v === 'accept' || v === 'decline') mcpElicitAnswer(v);
}

if (typeof module !== 'undefined') module.exports = {mcpElicitTitle, mcpElicitIsConfirm, mcpElicitDefaults, mcpElicitContent};
