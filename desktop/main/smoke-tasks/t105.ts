/**
 * Release-fix checks (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=105`. The small batch of 06.10:
 *
 * ATO-235 — a Fusion call with two tasks said "Delegating 1 task" over its
 * approval. A live card's args are the stream's label, clipped to 120
 * characters, and the count was the `"instructions"` keys left in the clip.
 * Now a count comes only from whole args, or from the fan-out's own approval
 * request ("2 tasks to 2 workers on …"); without either, no number.
 *
 * ATO-236 — a cancelled task still showed a Next run, in the list and on its
 * page. A cancelled, completed or failed task fires no more.
 *
 * ATO-237 — tool times read "48951ms", and a call held for an approval
 * counted the wait. They read in words now, timed from the answer.
 *
 * ATO-240 — a turned-off MCP server's row had nothing but its switch, so it
 * read as one that cannot be removed. Every row has Remove, which opens the
 * same confirm as the detail's.
 *
 * 06.10 (Nadya, Windows) — after the first message the bubble stood in the
 * middle of the window with "Working…" under it: the transcript sat on the
 * composer (chat review Д19), and the download card's lift raised it further.
 * A chat with messages starts at the top now; the empty chat's greeting still
 * stands in the middle.
 *
 * Everything is staged in the window's own state and put back: rows drawn into
 * detached elements, a staged transcript in a new chat, a staged approval with
 * no chat of its own. Nothing reaches the agent and nothing is written; the
 * remove confirm is opened and closed, never confirmed.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };

const show = (s: unknown) => JSON.stringify(s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* A renderer error is a failed check, never a thrown one (see t09). */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return (await js<T & Failed>(code)) ?? ({ err: "the renderer answered nothing" } as T & Failed);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

export async function checks105(js: Js, check: Check): Promise<void> {
  await fusionCount(js, check);
  await nextRun(js, check);
  await toolTimes(js, check);
  await mcpRemove(js, check);
  await chatFromTop(js, check);
}

/* ATO-235. */
async function fusionCount(js: Js, check: Check): Promise<void> {
  const r = await safe<{ skipped?: boolean; clipped: string; clip: string; whole: string; wholeText: string; fromAppr: string }>(js, `(() => {
    if (S.turnId || S.streamId || S.busy || S.pending || RUNNING.size > 0) return {skipped: true};
    const args = {tasks: [{id: 'a', title: 'first', instructions: 'smoke t105: ' + 'x'.repeat(160)}, {id: 'b', title: 'second', instructions: 'y'}], maxWorkers: 2};
    const clip = JSON.stringify(args).slice(0, 120);
    const line = (m) => toolLine(Object.assign({name: 'fusion.delegate'}, m)).replace(/<[^>]+>/g, '');
    const keep = {log: S.log, pending: S.pending, focused: S.apprFocused, busy: S.busy};
    try {
      const card = {id: nid(), k: 'tool', name: 'fusion.delegate', arg: clip, args: clip, ok: null, open: false, startedAt: Date.now()};
      S.log = [{id: nid(), k: 'user', text: 'smoke t105: split this in two'}, card];
      onApprovalEvent({approvalId: 'smoke-t105-fz', tool: 'fusion.delegate', category: 'fusion_fanout',
        reason: '2 tasks to 2 workers on smoke-model', preview: '  \\u2022 first\\n  \\u2022 second'});
      return {clipped: line({args: clip}), clip, whole: line({args: args}), wholeText: line({args: JSON.stringify(args)}), fromAppr: line(card)};
    } finally {
      S.log = keep.log; S.pending = keep.pending; S.apprFocused = keep.focused; S.busy = keep.busy;
      render();
    }
  })()`);
  if (r.skipped) { check("T105 ATO-235: the probe ran (the window was idle)", false, "a turn or an approval was in the way"); return; }
  check(
    "T105 ATO-235: a clipped label holding one of two tasks' \"instructions\" gives no number at all",
    !r.err && /"instructions"/.test(r.clip) && (r.clip.match(/"instructions"/g) || []).length === 1 && r.clipped === "Delegated tasks",
    r.err ?? show({ clipped: r.clipped, clip: r.clip }),
  );
  check(
    "T105 ATO-235: whole args count their tasks, as an object or as JSON",
    !r.err && r.whole === "Delegated 2 tasks" && r.wholeText === "Delegated 2 tasks",
    r.err ?? show({ whole: r.whole, wholeText: r.wholeText }),
  );
  check(
    "T105 ATO-235: the fan-out's approval request gives the live card its count (\"2 tasks to 2 workers\")",
    !r.err && r.fromAppr === "Delegated 2 tasks",
    r.err ?? show({ fromAppr: r.fromAppr }),
  );
}

/* ATO-236. */
async function nextRun(js: Js, check: Check): Promise<void> {
  type Out = { list: Record<string, string>; pages: Record<string, boolean> };
  const r = await safe<Out>(js, `(() => {
    const keep = {rows: TK.rows, mode: TK.mode, filter: TK.filter, search: TK.search, searchOpen: TK.searchOpen, detailId: TK.detailId, cursor: TK.cursor, cancel: TK.cancel};
    try {
      const now = Date.now();
      TK.rows = ['pending', 'running', 'blocked', 'cancelled', 'completed', 'failed'].map((status, i) => tkRow({
        id: 'smoke-t105-' + status, status, origin: 'smoke', userMessage: 'smoke t105 ' + status,
        schedule: {kind: 'cron', expression: '0 * * * *'}, recurring: true, scheduledFor: now + (i + 1) * 3600000,
        createdAt: now - 60000, updatedAt: now - 60000, attempts: 0, maxAttempts: 3}));
      TK.mode = 'list'; TK.filter = 'all'; TK.search = ''; TK.searchOpen = false; TK.cancel = null; TK.cursor = 0;
      const box = document.createElement('div');
      box.innerHTML = tkListHTML();
      const list = {};
      box.querySelectorAll('tr[data-task-row]').forEach((tr) => {
        const cell = tr.querySelector('td.set-next');
        list[tr.getAttribute('data-task-row').replace('smoke-t105-', '')] = cell ? cell.textContent.trim() : '(no cell)';
      });
      const pages = {};
      TK.rows.forEach((row) => {
        TK.detailId = row.id;
        box.innerHTML = tkDetailHTML();
        pages[row.status] = [...box.querySelectorAll('.set-plate dt')].some((dt) => dt.textContent.trim() === 'Next run');
      });
      return {list, pages};
    } finally {
      Object.assign(TK, keep);
    }
  })()`);
  const over = ["cancelled", "completed", "failed"], live = ["pending", "running", "blocked"];
  check(
    "T105 ATO-236: a cancelled, completed or failed task's Next run is a dash in the list; the others keep theirs",
    !r.err && over.every((s) => r.list[s] === "—") && live.every((s) => typeof r.list[s] === "string" && r.list[s] !== "—" && r.list[s] !== "(no cell)"),
    r.err ?? show(r.list),
  );
  check(
    "T105 ATO-236: the task's page has no Next run row once it fires no more",
    !r.err && over.every((s) => r.pages[s] === false) && live.every((s) => r.pages[s] === true),
    r.err ?? show(r.pages),
  );
}

/* ATO-237. */
async function toolTimes(js: Js, check: Check): Promise<void> {
  const r = await safe<{ words: string[]; live: { ms: number; waited: number } | null; stored: { ms: number; waited: number } | null; plain: { ms: number; waited: number } | null }>(js, `(() => {
    const words = [0, 850, 4900, 42000, 102000, 3725000].map(dur);
    const t0 = 1700000000000;
    // Live: seen at t0, answered 300 s later, the result 2 s after that.
    const live = toolTook({observedMs: 302000, startedAt: t0, apprAt: t0 + 300000});
    // Stored: the trace's 302078 ms ends at traceTs; the receipt says when you answered.
    const stored = toolTook({msSource: 'trace', ms: 302078, traceTs: t0 + 302078, apprAt: t0 + 300000});
    const plain = toolTook({msSource: 'trace', ms: 48951, traceTs: t0});
    return {words, live, stored, plain};
  })()`);
  check(
    "T105 ATO-237: times read in words: 0 ms, 850 ms, 4.9 s, 42 s, 1 min 42 s, 1 h 2 min",
    !r.err && show(r.words) === show(["0 ms", "850 ms", "4.9 s", "42 s", "1 min 42 s", "1 h 2 min"]),
    r.err ?? show(r.words),
  );
  check(
    "T105 ATO-237: a call that waited for an approval is timed from the answer, the wait apart; one that did not is as measured",
    !r.err && show(r.live) === show({ ms: 2000, waited: 300000 }) && show(r.stored) === show({ ms: 2078, waited: 300000 })
      && show(r.plain) === show({ ms: 48951, waited: 0 }),
    r.err ?? show({ live: r.live, stored: r.stored, plain: r.plain }),
  );
}

/* ATO-240. */
async function mcpRemove(js: Js, check: Check): Promise<void> {
  type Out = { rows: Record<string, { remove: boolean; restart: boolean }>; confirm: string | null; modal: boolean };
  const r = await safe<Out>(js, `(() => {
    const keep = {cfg: LIVE_CONFIG, mode: MCP.mode, cursor: MCP.cursor, detailName: MCP.detailName, removeConfirm: MCP.removeConfirm, addModal: MCP.addModal};
    try {
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {mcp: {servers: [
        {name: 'smoke-t105-on', enabled: true, transport: {kind: 'stdio', command: 'smoke-t105'}},
        {name: 'smoke-t105-off', enabled: false, transport: {kind: 'stdio', command: 'smoke-t105'}}]}});
      MCP.mode = 'list'; MCP.cursor = 0; MCP.removeConfirm = null; MCP.addModal = null;
      const box = document.createElement('div');
      box.innerHTML = mcpListHTML(mcpRows());
      const rows = {};
      box.querySelectorAll('[data-mcp-row]').forEach((row) => {
        const name = row.getAttribute('data-mcp-row');
        rows[name] = {remove: !!row.querySelector('[data-act="mcp:remove:' + name + '"]'), restart: !!row.querySelector('[data-act="mcp:restart:' + name + '"]')};
      });
      const act = box.querySelector('[data-act="mcp:remove:smoke-t105-off"]');
      if (act) mcpAct(act.getAttribute('data-act').slice(4));
      const confirm = MCP.removeConfirm ? MCP.removeConfirm.name : null;
      box.innerHTML = MCP.removeConfirm ? mcpRemoveModalHTML() : '';
      return {rows, confirm, modal: !!box.querySelector('[data-act="mcp:removeConfirm"]') && box.textContent.includes('smoke-t105-off')};
    } finally {
      LIVE_CONFIG = keep.cfg; MCP.mode = keep.mode; MCP.cursor = keep.cursor; MCP.detailName = keep.detailName;
      MCP.removeConfirm = keep.removeConfirm; MCP.addModal = keep.addModal;
      render();
    }
  })()`);
  const on = r.rows?.["smoke-t105-on"], off = r.rows?.["smoke-t105-off"];
  check(
    "T105 ATO-240: a turned-off MCP server's row has Remove, as a turned-on one's does (Restart stays for the one that is on)",
    !r.err && !!on && !!off && on.remove && off.remove && on.restart && !off.restart,
    r.err ?? show(r.rows),
  );
  check(
    "T105 ATO-240: the off row's Remove opens the same confirm, naming that server",
    !r.err && r.confirm === "smoke-t105-off" && r.modal,
    r.err ?? show({ confirm: r.confirm, modal: r.modal }),
  );
}

/* 06.10 — the transcript starts at the top. */
async function chatFromTop(js: Js, check: Check): Promise<void> {
  type Box = { colTop: number; bubbleTop: number; working: boolean; workingTop: number | null; below: number } | null;
  const r = await safe<{ skipped?: boolean; plain: Box; lifted: Box; empty: { flex: boolean; off: number; height: number } | null }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    if (S.turnId || S.streamId || S.busy || S.pending || RUNNING.size > 0 || OPENING) return {skipped: true};
    const root = document.documentElement.style;
    const keepLift = root.getPropertyValue('--dlcard-chat');
    const keep = {busy: S.busy, streamId: S.streamId, startedAt: S.turnStartedAt, stick: S.stick};
    // Laid out, not scrolled: a chat held at its end (S.stick) scrolls down to clear the card, which is not this.
    const measure = () => {
      const sc = document.querySelector('#scroller'), col = sc && sc.querySelector(':scope > .col720');
      if (sc) sc.scrollTop = 0;
      const bubble = sc && sc.querySelector('.turn.usr .bubble'), w = sc && sc.querySelector('.tk-working');
      if (!col || !bubble) return null;
      const s = sc.getBoundingClientRect();
      return {colTop: Math.round(col.getBoundingClientRect().top - s.top), bubbleTop: Math.round(bubble.getBoundingClientRect().top - s.top),
        working: !!w, workingTop: w ? Math.round(w.getBoundingClientRect().top - s.top) : null,
        below: Math.round(s.bottom - bubble.getBoundingClientRect().bottom)};
    };
    try {
      await window.__newSession(); await tick(150);
      S.room = 'chat';
      const reply = {id: nid(), k: 'assistant', text: ''};
      S.log = [{id: nid(), k: 'user', text: 'smoke t105: the first message of a new chat'}, reply];
      S.streamId = reply.id; S.busy = true; S.turnStartedAt = Date.now() - 5000; S.stick = false;
      render(); await tick(80);
      const plain = measure();
      // The download card's lift, as dlCardPublish sets it.
      root.setProperty('--dlcard-chat', '320px');
      render(); await tick(80);
      const lifted = measure();
      root.setProperty('--dlcard-chat', keepLift || '0px');
      S.streamId = keep.streamId; S.busy = keep.busy; S.turnStartedAt = keep.startedAt;
      S.log = [];
      render(); await tick(80);
      const sc = document.querySelector('#scroller'), em = sc && sc.querySelector('.emptychat .emptyplate');
      const empty = sc && em ? (() => {
        const s = sc.getBoundingClientRect(), e = em.getBoundingClientRect();
        return {flex: getComputedStyle(sc.querySelector('.emptychat')).display === 'flex',
          off: Math.round((e.top + e.bottom) / 2 - (s.top + s.bottom) / 2), height: Math.round(s.height)};
      })() : null;
      return {plain, lifted, empty};
    } finally {
      if (keepLift) root.setProperty('--dlcard-chat', keepLift); else root.removeProperty('--dlcard-chat');
      S.streamId = keep.streamId; S.busy = keep.busy; S.turnStartedAt = keep.startedAt; S.stick = keep.stick;
      await window.__newSession();
    }
  })()`);
  if (r.skipped) { check("T105 06.10: the probe ran (the window was idle)", false, "a turn, an approval or a chat opening was in the way"); return; }
  const p = r.plain, l = r.lifted, e = r.empty;
  check(
    "T105 06.10: the first message of a new chat stands at the top, \"Working…\" right under it, the free space below",
    !r.err && !!p && Math.abs(p.colTop) <= 1 && p.bubbleTop < 60 && p.working && p.workingTop !== null && p.workingTop > p.bubbleTop
      && p.workingTop < p.bubbleTop + 200 && p.below > 200,
    r.err ?? show(p),
  );
  check(
    "T105 06.10: the download card's lift does not move a short chat off the top",
    !r.err && !!p && !!l && l.bubbleTop === p.bubbleTop && Math.abs(l.colTop) <= 1,
    r.err ?? show({ plain: p, lifted: l }),
  );
  check(
    "T105 06.10: the empty chat's greeting still stands in the middle",
    !r.err && !!e && e.flex && Math.abs(e.off) < e.height * 0.2,
    r.err ?? show(e),
  );
}
