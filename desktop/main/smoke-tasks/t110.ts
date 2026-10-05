import { BrowserWindow } from "electron";

/**
 * Release-fix checks (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=110`. The small batch C of 06.10:
 *
 * ATO-181 — writing a file the request names was refused by the agent's own
 * overwrite guard (fs-input-guard.ts), and the card read "Couldn't write
 * test.txt" in red over the guard's note to the model. Such a call is `held`
 * now: "test.txt already exists — the agent will ask before replacing it", a
 * muted glyph, no red. A write that really failed keeps its red.
 *
 * ATO-224 — with a dialog or a popover open, ⌘↩ (Ctrl+↩ off macOS) reached
 * Send and sent the composer's draft from under it. It does nothing there now.
 *
 * ATO-207 — a live turn grew one reasoning row for all its steps. A tool call
 * ends its step: the next reasoning is a row of its own under the card.
 *
 * ATO-186 — Where it runs › Custom server named the built-in model's own
 * server ("your llama.cpp server at 127.0.0.1:29470"); and "New session · The
 * next turn starts fresh" stayed over the chat opened after it.
 *
 * ATO-182 — the context popover still had Done.
 *
 * ATO-131 — Clear Transcript pressed while a chat loaded was undone when the
 * load arrived.
 *
 * Rows are drawn into detached elements, a turn is staged in the window's own
 * state, the keys go through the real keydown handler with Send stood in.
 * GET /api/sessions/{id} is answered by a stand-in on the window's own IPC (a
 * webContents handler is asked before ipcMain's; a probe proves it first, as
 * in t22) that holds an answer until the check lets it go. Nothing reaches the
 * agent and nothing is written; the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };

const PREFIX = "smoke-t110-";
const PROBE = `${PREFIX}probe`;
const q = (v: unknown) => JSON.stringify(v);
const show = (s: unknown) => JSON.stringify(s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* A renderer error is a failed check, never a thrown one (see t09). */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return (await js<T & Failed>(code)) ?? ({ err: "the renderer answered nothing" } as T & Failed);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

export async function checks110(js: Js, check: Check): Promise<void> {
  await guardHeld(js, check);
  await sendUnderLayer(js, check);
  await reasoningSteps(js, check);
  await customServer(js, check);
  await contextDone(js, check);
  await slowLoads(js, check);
}

/* ATO-181. */
async function guardHeld(js: Js, check: Check): Promise<void> {
  type Card = { state: string; line: string | null; red: boolean; sum: boolean; glyph: string | null };
  const r = await safe<{ held: Card; fanned: Card; failed: Card; shell: Card; group: { red: boolean; glyph: string | null; line: string | null } }>(js, `(() => {
    const box = document.createElement('div');
    const draw = (m) => {
      box.innerHTML = toolCard(m);
      const c = box.querySelector('.card');
      const nm = c && c.querySelector('.nm');
      const st = c && c.querySelector('.tl-st');
      return {state: toolState(m), line: nm ? nm.textContent : null, red: !!c && c.classList.contains('err'),
        sum: !!c && !!c.querySelector('.cardsum.bad'), glyph: st ? st.className : null};
    };
    const write = (path, out) => ({id: nid(), k: 'tool', name: 'os.fs.write', arg: '', args: JSON.stringify({path, content: 'smoke t110'}), ok: false, open: false, out});
    // The guard's own two texts (fs-input-guard.ts refusal()).
    const named = (p) => 'refused: ' + p + ' is an input the request names (1 line \\u2192 1); edit it in place (os.fs.edit / os.fs.patch), or pass overwrite: true if replacing it is really what the user asked for';
    const declared = (p) => 'refused: ' + p + ' is an input this fan-out declared (3 lines \\u2192 1); edit it in place (os.fs.edit / os.fs.patch) \\u2014 a worker cannot replace a declared input; if the task needs it replaced, say so in your reply so the orchestrator can redeclare it';
    const held = draw(write('/Users/smoke/test.txt', named('/Users/smoke/test.txt')));
    const fanned = draw(write('data.csv', declared('data.csv')));
    const failed = draw(write('/Users/smoke/test.txt', "EACCES: permission denied, open '/Users/smoke/test.txt'"));
    // The same words in another tool's output are that tool's failure, not the guard.
    const shell = draw(Object.assign(write('a.txt', named('a.txt')), {name: 'os.shell.run', args: JSON.stringify({cmd: 'cat', args: ['a.txt']})}));
    box.innerHTML = groupCard([write('a.txt', named('a.txt')), write('b.txt', named('b.txt')), write('c.txt', named('c.txt'))]);
    const g = box.querySelector('.card');
    const group = {red: !!g && g.classList.contains('err'), glyph: g && g.querySelector('.tl-st') ? g.querySelector('.tl-st').className : null,
      line: g && g.querySelector('.nm') ? g.querySelector('.nm').textContent : null};
    return {held, fanned, failed, shell, group};
  })()`);
  check(
    "T110 ATO-181: a write the overwrite guard held back reads \"test.txt already exists — the agent will ask before replacing it\", calm, no red",
    !r.err && r.held.state === "held" && r.held.line === "test.txt already exists — the agent will ask before replacing it"
      && !r.held.red && !r.held.sum && r.held.glyph === "tl-st held",
    r.err ?? show(r.held),
  );
  check(
    "T110 ATO-181: a Fusion worker's declared input reads as left as it is, calm, no red",
    !r.err && r.fanned.state === "held" && r.fanned.line === "data.csv is an input of this task — the worker left it as it is"
      && !r.fanned.red && !r.fanned.sum,
    r.err ?? show(r.fanned),
  );
  check(
    "T110 ATO-181: a write that really failed, and another tool's output with the same words, stay red failures",
    !r.err && r.failed.state === "err" && r.failed.red && r.failed.sum && /^Couldn’t write /.test(r.failed.line ?? "")
      && r.failed.glyph === "tl-st err" && r.shell.state === "err" && r.shell.red,
    r.err ?? show({ failed: r.failed, shell: r.shell }),
  );
  check(
    "T110 ATO-181: a folded run of held writes is not red either",
    !r.err && !r.group.red && r.group.glyph === "tl-st held" && r.group.line === "Didn’t write files · 3 times",
    r.err ?? show(r.group),
  );
}

/* ATO-224. */
async function sendUnderLayer(js: Js, check: Check): Promise<void> {
  const r = await safe<{ skipped?: boolean; none: number; layers: Record<string, number>; alertKept: boolean }>(js, `(() => {
    if (S.busy || S.pending || OB.open) return {skipped: true};
    const keep = {submit, alert: S.alert, sel: SEL.open, wiz: WIZ.phase, overlay: S.overlay, settings: S.settings, menu: S.menuOpen};
    let sent = 0;
    const out = {layers: {}};
    try {
      // Send stood in: what ⌘↩ would send is counted, never sent.
      submit = () => { sent++; };
      const press = () => {
        sent = 0;
        document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', metaKey: IS_MAC, ctrlKey: !IS_MAC, bubbles: true, cancelable: true}));
        return sent;
      };
      const bare = () => { S.alert = null; SEL.open = false; WIZ.phase = null; S.overlay = null; S.settings = null; S.menuOpen = null; };
      bare();
      out.none = press();
      const layers = {
        deleteChat: () => { S.alert = {title: 'Delete \\u201csmoke t110\\u201d?', msg: 'smoke t110', ok: 'Delete', act: 'smoke-t110:noop'}; },
        modelPicker: () => { SEL.open = true; },
        providerWizard: () => { WIZ.phase = 'pick'; },
        modePopover: () => { S.overlay = 'modes'; },
        contextPopover: () => { S.overlay = 'context'; },
        palette: () => { S.overlay = 'palette'; },
        settings: () => { S.settings = 1; },
        menu: () => { S.menuOpen = 0; },
      };
      for (const [name, open] of Object.entries(layers)) { bare(); open(); out.layers[name] = press(); }
      bare(); layers.deleteChat(); press();
      out.alertKept = !!S.alert && S.alert.act === 'smoke-t110:noop';
      return out;
    } finally {
      submit = keep.submit;
      S.alert = keep.alert; SEL.open = keep.sel; WIZ.phase = keep.wiz; S.overlay = keep.overlay; S.settings = keep.settings; S.menuOpen = keep.menu;
      render();
    }
  })()`);
  if (r.skipped) { check("T110 ATO-224: the probe ran (the window was idle)", false, "a turn, a request or setup was in the way"); return; }
  const names = ["deleteChat", "modelPicker", "providerWizard", "modePopover", "contextPopover", "palette", "settings", "menu"];
  check(
    "T110 ATO-224: ⌘↩ (Ctrl+↩) sends with nothing over the chat",
    !r.err && r.none === 1,
    r.err ?? show({ none: r.none }),
  );
  check(
    "T110 ATO-224: ⌘↩ (Ctrl+↩) sends nothing under Delete chat?, the model picker, the provider wizard, a popover, the palette, Settings or the menu",
    !r.err && names.every((n) => r.layers[n] === 0),
    r.err ?? show(r.layers),
  );
  check(
    "T110 ATO-224: under Delete chat? it does not confirm the delete either",
    !r.err && r.alertKept,
    r.err ?? show({ alertKept: r.alertKept }),
  );
}

/* ATO-207. */
async function reasoningSteps(js: Js, check: Check): Promise<void> {
  const r = await safe<{ skipped?: boolean; rows: string[]; lastReason: boolean; afterCall: string | null; stored: string[]; discs: string[] }>(js, `(() => {
    if (S.busy || S.turnId || S.pending) return {skipped: true};
    const saved = {log: S.log, streamId: S.streamId, turnId: S.turnId, busy: S.busy, reasonId: S.reasonId, room: S.room, stick: S.stick};
    try {
      const turnId = 'smoke-t110-turn-' + Date.now().toString(16);
      const reply = {id: nid(), k: 'assistant', text: ''};
      S.room = 'chat';
      S.log = [{id: nid(), k: 'user', text: 'smoke t110: remember my name and that I like tea'}, reply];
      S.streamId = reply.id; S.turnId = turnId; S.busy = true; S.reasonId = null;
      const ev = (kind, extra) => onChatEvent(Object.assign({turnId, kind}, extra));
      ev('reasoning_progress', {payload: {delta: 'smoke t110: first the name'}});
      ev('reasoning_progress', {payload: {delta: ', Nadya'}});
      ev('tool_progress', {payload: {tool: 'memory.profile.set', label: '{"key":"name"}'}});
      ev('reasoning_progress', {payload: {delta: 'smoke t110: then the drink'}});
      ev('tool_progress', {payload: {tool: 'memory.profile.set', label: '{"key":"drink"}'}});
      ev('reasoning_progress', {payload: {delta: 'smoke t110: now the answer'}});
      const rows = S.log.map((m) => m.k === 'reason' ? 'reason ' + m.steps + ': ' + m.text : m.k);
      const box = document.createElement('div');
      // A chat opened again mid-turn picks the last row up only while no call came after it.
      const rec = {asked: S.log[0], item: reply};
      const lastReason = !!S.reasonId && liveReasonId(rec) === S.reasonId;
      S.log.splice(S.log.indexOf(reply), 0, {id: nid(), k: 'tool', name: 'os.fs.list', arg: '', ok: null, open: false});
      const afterCall = liveReasonId(rec);
      // A stored chat: one row per call, its step counted within its turn.
      const stored = sessionTurnsToLog([
        {kind: 'user', text: 'smoke t110: q1'},
        {kind: 'assistant_tool_call', tool: 'memory.profile.set', args: {key: 'name'}, reasoning: 'smoke t110: one'},
        {kind: 'tool_result', tool: 'memory.profile.set', status: 'ok', summary: 'ok'},
        {kind: 'assistant_tool_call', tool: 'memory.profile.set', args: {key: 'drink'}, reasoning: 'smoke t110: two'},
        {kind: 'tool_result', tool: 'memory.profile.set', status: 'ok', summary: 'ok'},
        {kind: 'assistant_reply', text: 'smoke t110: a1'},
        {kind: 'user', text: 'smoke t110: q2'},
        {kind: 'assistant_tool_call', tool: 'os.fs.list', args: {path: '.'}, reasoning: 'smoke t110: three'},
        {kind: 'tool_result', tool: 'os.fs.list', status: 'ok', summary: 'total: 0 entries'},
      ]).filter((m) => m.k === 'reason').map((m) => m.steps + ': ' + m.text);
      box.innerHTML = renderItems();
      const discs = [...box.querySelectorAll('.disc span')].map((s) => s.textContent);
      return {rows, lastReason, afterCall, stored, discs};
    } finally {
      if (typeof dropStreamPaint === 'function') dropStreamPaint();
      S.log = saved.log; S.streamId = saved.streamId; S.turnId = saved.turnId; S.busy = saved.busy; S.reasonId = saved.reasonId;
      S.room = saved.room; S.stick = saved.stick;
      render();
    }
  })()`);
  if (r.skipped) { check("T110 ATO-207: the probe ran (the window was idle)", false, "a turn or a request was in the way"); return; }
  check(
    "T110 ATO-207: a live turn draws each step's reasoning as its own row, above that step's call, numbered by step",
    !r.err && show(r.rows) === show(["user", "reason 1: smoke t110: first the name, Nadya", "tool", "reason 2: smoke t110: then the drink",
      "tool", "reason 3: smoke t110: now the answer", "assistant"])
      && show(r.discs) === show(["Reasoning", "Reasoning", "Reasoning"]),
    r.err ?? show({ rows: r.rows, discs: r.discs }),
  );
  check(
    "T110 ATO-207: a chat opened again mid-turn grows its last reasoning row only while no call came after it",
    !r.err && r.lastReason && r.afterCall === null,
    r.err ?? show({ lastReason: r.lastReason, afterCall: r.afterCall }),
  );
  check(
    "T110 ATO-207: a stored chat numbers each turn's steps from 1",
    !r.err && show(r.stored) === show(["1: smoke t110: one", "2: smoke t110: two", "1: smoke t110: three"]),
    r.err ?? show(r.stored),
  );
}

/* ATO-186 (a). */
async function customServer(js: Js, check: Check): Promise<void> {
  type Out = { managed: string; loopback: string; remote: string; external: string; empty: string; row: string | null; rowExt: string | null; rowErr?: string };
  const r = await safe<Out>(js, `(() => {
    const keep = {cfg: LIVE_CONFIG, kind: SEL.kind};
    const at = (lm) => { LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {localModels: lm}); return customServerUrl(); };
    const MANAGED = {mode: 'managed', url: 'http://127.0.0.1:29470', managed: {port: 29470}};
    const row = (lm) => {
      at(lm);
      SEL.kind = 'backend';
      const c = selRows().find((x) => x.id === 'custom');
      return c ? c.detail : null;
    };
    try {
      const out = {
        managed: at(MANAGED),
        loopback: at({mode: 'managed', url: 'http://localhost:8081'}),
        remote: at({mode: 'managed', url: 'http://192.168.1.20:8080'}),
        external: at({mode: 'external', url: 'http://127.0.0.1:8081'}),
        empty: at({mode: 'external', url: ''}),
      };
      try {
        out.row = row(MANAGED);
        out.rowExt = row({mode: 'external', url: 'http://10.0.0.5:8080'});
      } catch (e) { out.rowErr = String((e && e.message) || e); }
      return out;
    } finally {
      LIVE_CONFIG = keep.cfg; SEL.kind = keep.kind;
    }
  })()`);
  check(
    "T110 ATO-186: the built-in model's own server (managed, 127.0.0.1 and its port) is not named as yours; an external route's address is",
    !r.err && r.managed === "" && r.loopback === "" && r.remote === "http://192.168.1.20:8080"
      && r.external === "http://127.0.0.1:8081" && r.empty === "",
    r.err ?? show(r),
  );
  check(
    "T110 ATO-186: Where it runs › Custom server on a managed route says to set one up; on an external route it names that server",
    !r.err && !r.rowErr && r.row === "your own llama.cpp server · set it up in Settings › Models"
      && r.rowExt === "your llama.cpp server at 10.0.0.5:8080",
    r.err ?? r.rowErr ?? show({ row: r.row, rowExt: r.rowExt }),
  );
}

/* ATO-182. */
async function contextDone(js: Js, check: Check): Promise<void> {
  const r = await safe<{ foot: string[] | null; done: boolean }>(js, `(() => {
    const box = document.createElement('div');
    box.innerHTML = contextHTML();
    const foot = box.querySelector('.ctxpop .popfoot');
    return {foot: foot ? [...foot.querySelectorAll('button')].map((b) => b.textContent.trim() + ' | ' + (b.getAttribute('data-act') || '')) : null,
      done: [...box.querySelectorAll('.ctxpop button')].some((b) => b.textContent.trim() === 'Done')};
  })()`);
  check(
    "T110 ATO-182: the context popover has no Done; Clear transcript stays",
    !r.err && show(r.foot) === show(["Clear transcript | clear"]) && !r.done,
    r.err ?? show(r),
  );
}

/** GET /api/sessions/{id} as a slow agent: an answer asked for with hold() waits for release() (t22). */
class SlowAgent {
  private readonly holds = new Map<string, number>();
  private readonly asked = new Map<string, number>();
  private readonly held: Array<{ id: string; answer: (value: unknown) => void }> = [];

  readonly handler = (_event: unknown, id: unknown): unknown => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT110: true } };
    const n = this.holds.get(sid) ?? 0;
    if (n > 0) {
      this.holds.set(sid, n - 1);
      this.asked.set(sid, (this.asked.get(sid) ?? 0) + 1);
      return new Promise((answer) => { this.held.push({ id: sid, answer }); });
    }
    return { ok: false, error: "smoke t110: not answered while the check runs" };
  };

  hold(id: string): void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
  }

  async waitFor(id: string, count: number): Promise<boolean> {
    const t0 = Date.now();
    while ((this.asked.get(id) ?? 0) < count && Date.now() - t0 < 3000) await wait(20);
    return (this.asked.get(id) ?? 0) >= count;
  }

  release(id: string, value: unknown): void {
    const at = this.held.findIndex((h) => h.id === id);
    if (at >= 0) this.held.splice(at, 1)[0]!.answer(value);
  }

  releaseAll(): void {
    this.holds.clear();
    for (const h of this.held.splice(0)) h.answer({ ok: false, error: "smoke t110: let go at the end of the check" });
  }
}

const turns = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [
  { kind: "user", text: `smoke t110: ${tag} question ${i + 1}` },
  { kind: "assistant_reply", text: `smoke t110: ${tag} answer ${i + 1}` },
]).flat();
const loaded = (id: string, list: unknown[]) => ({ ok: true, data: { id, turns: list } });

type View = { sessionId: string; agentSession: string | null; rows: string[]; held: boolean; toasts: string[] };
const H = String.raw`
  const mine = (x) => typeof x === 'string' && x.indexOf('smoke-t110-') === 0;
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  const view = () => ({sessionId: S.sessionId, agentSession: S.agentSession,
    rows: S.log.map((m) => m.k + ':' + String(m.text || '').slice(0, 70)), held: openHoldsComposer(),
    toasts: S.toasts.map((t) => t.t)});
`;
const VIEW = `(() => { ${H} return view(); })()`;

const KEEP = `(() => {
  if (S.busy || S.pending || S.turnId || S.queued.length || OPENING) return false;
  window.__t110keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, history: S.history,
    room: S.room, streamId: S.streamId, reasonId: S.reasonId, stick: S.stick, settings: S.settings, toasts: S.toasts.slice(),
    stamp: CTX055.stamp, ahead: STEER.ahead, owed: typeof DRAIN_OWED !== 'undefined' ? DRAIN_OWED : null,
    plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
  return true;
})()`;
const RESTORE = `(async () => { ${H}
  await tick(150);   // the answers let go just before this are dealt with first
  const k = window.__t110keep; delete window.__t110keep;
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.history = k.history;
    S.room = k.room; S.streamId = k.streamId; S.reasonId = k.reasonId; S.stick = k.stick; S.settings = k.settings; S.toasts = k.toasts;
    CTX055.stamp = k.stamp; STEER.ahead = k.ahead; Object.assign(PLAN, k.plan);
    if (typeof DRAIN_OWED !== 'undefined') DRAIN_OWED = k.owed;
  }
  if (OPENING && mine(OPENING.id)) OPENING = null;
  OPEN_CLEARED = 0;
  if (typeof QUEUES !== 'undefined') for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
  renderToasts(); render();
  refreshContext();
  return true;
})()`;

/* Whatever the window does with an answer it was handed happens before the
   reply to a later request on the same channel; a beat on top for the repaint. */
async function settle(js: Js): Promise<void> {
  await js<unknown>(`BR.session(${q(PROBE)}).then(() => new Promise((res) => setTimeout(res, 150)))`);
}

/* ATO-186 (b) and ATO-131: a chat's toast, and Clear, against a load that is still out. */
async function slowLoads(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new SlowAgent();
  let kept = false;
  try {
    for (const x of wins) { x.webContents.ipc.removeHandler("agent:session"); x.webContents.ipc.handle("agent:session", agent.handler); }
    const probe = await js<{ data?: { smokeT110?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT110 !== true) {
      check("T110: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);
    if (!kept) { check("T110: the chat probes ran (the window was idle)", false, "a turn, a request, a queue or a load was in the way"); return; }

    // ATO-186 (b): New session on a chat, then another chat opened while its toast is up.
    const a = `${PREFIX}a`, b = `${PREFIX}b`;
    const fresh = await js<View>(`(() => { ${H}
      S.sessionId = ${q(a)}; S.agentSession = ${q(a)}; S.room = 'chat';
      S.log = [{id: nid(), k: 'user', text: 'smoke t110: a chat on screen'}];
      render();
      toast('smoke t110: a toast of its own', 'not the chat\\'s');
      act('session:new');
      return view();
    })()`);
    agent.hold(b);
    const switched = await js<View>(`(() => { ${H} openSession(${q(b)}); return view(); })()`);
    const heldB = await agent.waitFor(b, 1);
    agent.release(b, loaded(b, turns("B", 1)));
    await settle(js);
    check(
      "T110 ATO-186: \"New session · The next turn starts fresh\" goes when another chat is opened; a toast of its own stays",
      fresh.toasts.includes("New session") && fresh.toasts.includes("smoke t110: a toast of its own") && heldB
        && !switched.toasts.includes("New session") && switched.toasts.includes("smoke t110: a toast of its own"),
      `fresh=${show(fresh.toasts)} switched=${show(switched.toasts)} held=${heldB}`,
    );

    // ATO-131: Clear while the chat is still loading; then its answer arrives.
    const c = `${PREFIX}c`;
    agent.hold(c);
    await js<boolean>(`(() => { openSession(${q(c)}); return true; })()`);
    const heldC = await agent.waitFor(c, 1);
    const loading = await js<View>(VIEW);
    const cleared = await js<View>(`(() => { ${H} act('clear'); return view(); })()`);
    agent.release(c, loaded(c, turns("C", 2)));
    await settle(js);
    const after = await js<View>(VIEW);
    check(
      "T110 ATO-131: Clear pressed while a chat loads stays cleared when its transcript arrives",
      heldC && loading.sessionId === c && loading.rows[0] === "system:loading session…" && cleared.rows.length === 0
        && !after.rows.some((x) => x.includes("smoke t110: C")) && !after.rows.includes("system:loading session…"),
      `held=${heldC} loading=${show(loading.rows)} cleared=${show(cleared.rows)} after=${show(after)}`,
    );
    check(
      "T110 ATO-131: the cleared chat is still the one open: the next message continues it, and the composer is not held",
      after.sessionId === c && after.agentSession === c && !after.held,
      show(after),
    );

    // A later load of the same chat, with no Clear under it, lands whole.
    agent.hold(c);
    await js<boolean>(`(() => { openSession(${q(c)}); return true; })()`);
    const heldAgain = await agent.waitFor(c, 2);
    agent.release(c, loaded(c, turns("C", 2)));
    await settle(js);
    const again = await js<View>(VIEW);
    check(
      "T110 ATO-131: a later load of that chat, with no Clear under it, brings its transcript",
      heldAgain && again.sessionId === c && again.rows.filter((x) => x.includes("smoke t110: C")).length === 4,
      `held=${heldAgain} again=${show(again)}`,
    );
  } finally {
    /* The held answers are let go and the stand-in comes off before anything
       else is awaited (see t22). */
    agent.releaseAll();
    for (const x of wins) if (!x.isDestroyed()) x.webContents.ipc.removeHandler("agent:session");
    if (kept) await js<unknown>(RESTORE).catch(() => undefined);
  }
}
