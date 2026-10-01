/**
 * Release-fix checks for backlog item 10 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=10`.
 */

import { BrowserWindow } from "electron";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

type Box = { gap: number; h: number };
type Sent = { error?: string; first?: string | null; refused?: boolean; gone?: boolean };
type Staged = {
  error?: string;
  drawn?: { text: string | null; under: boolean; asst: boolean | null; replyRow: boolean; lastReply: string | null; anim: string | null; reduced: boolean };
  tick?: { start: string | null; now: string | null; ms: number; renders: number; same: boolean };
  reasoning?: { ms: number; lineBox: Box | null; reasonBox: Box | null; next: boolean };
  back1?: boolean;
  tool?: { ms: number; card: boolean };
  back2?: boolean;
  blank?: boolean;
  words?: { ms: number; text: string };
  after?: { tick: number | null; line: boolean; log: boolean; busy: boolean; streamId: boolean; turnId: boolean };
};

const REFUSAL = "smoke t10: this turn stays in the window";

export async function checks10(js: Js, check: Check): Promise<void> {
  /* 10 — after a send the transcript stayed empty for the 30-40 s a local
     model reads the prompt; now a "Working…" line with the seconds is there.

     The send itself first, through the real startLiveTurn. Its BR.chat is
     answered by a stand-in on the window's own IPC, which refuses the turn,
     so nothing reaches the agent (a webContents handler is asked before
     ipcMain's; that is proved on a read-only channel before the send relies
     on it). An earlier turn's stamp is planted: the first frame must count
     from this send, not from that. */
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) w.webContents.ipc.handle("app:hostRam", () => "smoke-t10");
  const answered = await js<unknown>("BR.hostRam()").catch((e: unknown) => String(e)).finally(() => {
    for (const w of wins) w.webContents.ipc.removeHandler("app:hostRam");
  });
  let sent: Sent = { error: `a stand-in on the window's IPC did not answer first (${JSON.stringify(answered)}); the send was not staged` };
  if (answered === "smoke-t10") {
    for (const w of wins) w.webContents.ipc.handle("agent:chat", () => ({ ok: false, error: REFUSAL }));
    try {
      sent = await js<Sent>(`(async () => {
        const tick = (ms) => new Promise((res) => setTimeout(res, ms));
        const keep = {log: S.log, busy: S.busy, streamId: S.streamId, reasonId: S.reasonId, stick: S.stick, room: S.room,
          had: 'turnStartedAt' in S, started: S.turnStartedAt, history: S.history.length, fz: FZ.live,
          plan: {on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId, startedMode: PLAN.startedMode}};
        const text = 'smoke t10: a question for a slow model';
        const out = {};
        try {
          S.room = 'chat';
          S.turnStartedAt = Date.now() - 300000;
          S.log = keep.log.concat([{id: nid(), k: 'user', text}]);   // as submit() pushes it
          startLiveTurn(text);
          const el = document.querySelector('#scroller .tk-working');
          out.first = el ? el.textContent : null;
          // The refusal comes back through startLiveTurn's own failure path.
          const t0 = Date.now();
          while (S.busy && Date.now() - t0 < 3000) await tick(25);
          out.refused = S.log.some((m) => m.k === 'system' && m.text.includes(${JSON.stringify(REFUSAL)}));
          out.gone = !document.querySelector('#scroller .tk-working');
        } catch (e) {
          out.error = String((e && e.stack) || e);
        } finally {
          S.log = keep.log; S.busy = keep.busy; S.streamId = keep.streamId; S.reasonId = keep.reasonId;
          S.stick = keep.stick; S.room = keep.room;
          if (keep.had) S.turnStartedAt = keep.started; else delete S.turnStartedAt;
          S.history.length = keep.history; FZ.live = keep.fz; Object.assign(PLAN, keep.plan);
          render();
        }
        return out;
      })()`);
    } finally {
      for (const w of wins) w.webContents.ipc.removeHandler("agent:chat");
    }
  }
  check(
    "T10: the send's first frame already says Working… 0 s, not the last turn's count, and a turn that ends takes it away",
    !sent.error && sent.first === "Working…0 s" && sent.refused === true && sent.gone === true,
    sent.error ?? JSON.stringify(sent),
  );

  /* Then a turn staged the way startLiveTurn leaves it (the message, an
     empty streaming reply, S.busy, the stamp), its frames through the real
     onChatEvent; no model is asked anything. Everything staged comes back
     out, and the log is the original array. */
  const r = await js<Staged>(`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const line = () => document.querySelector('#scroller .tk-working');
    const userRow = () => Array.from(document.querySelectorAll('#scroller .turn.usr')).pop() || null;
    // Where a row sits under the message, and how tall it is.
    const box = (n) => { const u = userRow(); if (!u || !n) return null; const b = n.getBoundingClientRect();
      return {gap: Math.round(b.top - u.getBoundingClientRect().bottom), h: Math.round(b.height)}; };
    // A frame may repaint on the next frame rather than at once; give it a moment.
    const gone = async () => { const t0 = Date.now(); while (line() && Date.now() - t0 < 1500) await tick(25); return line() ? -1 : Date.now() - t0; };
    const keep = {log: S.log, busy: S.busy, streamId: S.streamId, turnId: S.turnId, reasonId: S.reasonId, stick: S.stick,
      room: S.room, had: 'turnStartedAt' in S, started: S.turnStartedAt, render};
    const user = {id: nid(), k: 'user', text: 'smoke t10: a question for a slow model'};
    const reply = {id: nid(), k: 'assistant', text: ''};
    const turnId = 'smoke-t10-' + Date.now().toString(16);
    const out = {};
    try {
      S.room = 'chat';
      S.log = keep.log.concat([user, reply]);
      S.streamId = reply.id; S.turnId = turnId; S.busy = true; S.stick = true;
      S.turnStartedAt = Date.now() - 5500;
      render();
      const el = line();
      const rows = Array.from(document.querySelectorAll('#scroller .col720 > *'));
      const at = el ? rows.indexOf(el) : -1;
      const above = at > 0 ? rows[at - 1] : null, below = at >= 0 ? rows[at + 1] || null : null;
      const word = el && el.querySelector('.tk-work-t');
      // drive.mjs lastReply(): the last non-user row with a .prose is "the reply".
      const replies = Array.from(document.querySelectorAll('#content .turn')).filter((n) => !n.classList.contains('usr') && n.querySelector('.prose'));
      const prose = below && below.querySelector('.tk-asst > .prose');
      out.drawn = {
        text: el ? el.textContent : null,
        under: !!above && above.classList.contains('usr') && above.textContent.includes(user.text),
        asst: el ? (!!el.closest('.tk-asst') || !!el.querySelector('.tk-asst, .prose')) : null,
        replyRow: !!prose && prose.textContent === '' && !!below.querySelector('.tk-asst > .msgacts'),
        lastReply: replies.length ? (replies[replies.length - 1].querySelector('.prose').innerText || '').trim() : null,
        anim: word ? getComputedStyle(word).animationName : null,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
      // The seconds move with render() doing nothing: the line's own clock.
      const counter = el && el.querySelector('.tk-work-n');
      const lineBox = box(el);
      const start = counter ? counter.textContent : null;
      let renders = 0;
      render = () => { renders++; };
      const t0 = Date.now();
      try { while (counter && counter.textContent === start && Date.now() - t0 < 2500) await tick(25); }
      finally { render = keep.render; }
      out.tick = {start, now: counter ? counter.textContent : null, ms: Date.now() - t0, renders, same: !!counter && counter.isConnected};
      // The first reasoning frame: spliced ahead of the reply, it takes the line's place.
      onChatEvent({turnId, kind: 'reasoning_progress', payload: {delta: 'Reading the question.'}});
      const reasonMs = await gone();
      const block = S.log.find((m) => m.k === 'reason' && m.id === S.reasonId) || null;
      const reasonRow = block ? document.getElementById('turn-' + block.id) : null;
      out.reasoning = {ms: reasonMs, lineBox, reasonBox: box(reasonRow), next: !!reasonRow && !!userRow() && userRow().nextElementSibling === reasonRow};
      // Back to nothing on screen, then a tool step.
      S.log = S.log.filter((m) => m !== block); S.reasonId = null; render();
      out.back1 = !!line();
      onChatEvent({turnId, kind: 'tool_progress', payload: {tool: 'os.fs.list_dir', label: '{"path":"~"}'}});
      const toolMs = await gone();
      const next = userRow() && userRow().nextElementSibling;
      out.tool = {ms: toolMs, card: !!next && !!next.querySelector('.card')};
      S.log = S.log.filter((m) => !(m.k === 'tool' && m.turn === turnId)); render();
      out.back2 = !!line();
      // A blank first delta is still nothing to read; words are.
      onChatEvent({turnId, kind: 'delta', text: '\\n'});
      out.blank = !!line();
      onChatEvent({turnId, kind: 'delta', text: 'Hello'});
      out.words = {ms: await gone(), text: reply.text};
    } catch (e) {
      out.error = String((e && e.stack) || e);
    } finally {
      render = keep.render;
      S.log = keep.log; S.busy = keep.busy; S.streamId = keep.streamId; S.turnId = keep.turnId; S.reasonId = keep.reasonId;
      S.stick = keep.stick; S.room = keep.room;
      if (keep.had) S.turnStartedAt = keep.started; else delete S.turnStartedAt;
      render();
    }
    // Not left running: with no line on screen the clock stops on its next tick.
    await tick(1150);
    out.after = {tick: typeof WORKING_TICK === 'undefined' ? null : WORKING_TICK, line: !!line(), log: S.log === keep.log,
      busy: S.busy === keep.busy, streamId: S.streamId === keep.streamId, turnId: S.turnId === keep.turnId};
    return out;
  })()`);

  const d = r.drawn;
  check(
    "T10: Working… and the seconds sit under the message, and nothing reads the line as a reply",
    !r.error && !!d && d.text === "Working…5 s" && d.under && d.asst === false && d.replyRow && d.lastReply === "",
    r.error ?? JSON.stringify(d),
  );
  check(
    "T10: the word shimmers (still under reduced motion)",
    !!d && d.anim === (d.reduced ? "none" : "chat-shimmer"),
    JSON.stringify({ anim: d?.anim, reduced: d?.reduced }),
  );
  const t = r.tick;
  check(
    "T10: the seconds count on with render() idle",
    !!t && t.same && /^\d+ s$/.test(t.start ?? "") && parseInt(t.now ?? "", 10) === parseInt(t.start ?? "", 10) + 1 && t.ms < 1600,
    JSON.stringify(t),
  );
  const g = r.reasoning;
  check(
    "T10: the first reasoning frame takes the line's place, in its box",
    !!g && g.ms >= 0 && g.next && !!g.lineBox && !!g.reasonBox
      && Math.abs(g.lineBox.gap - g.reasonBox.gap) <= 1 && Math.abs(g.lineBox.h - g.reasonBox.h) <= 1,
    JSON.stringify(g),
  );
  check(
    "T10: a tool step or the reply's first words take the line away; a blank delta does not",
    r.back1 === true && !!r.tool && r.tool.ms >= 0 && r.tool.card && r.back2 === true && r.blank === true
      && !!r.words && r.words.ms >= 0 && r.words.text === "\nHello",
    JSON.stringify({ back1: r.back1, tool: r.tool, back2: r.back2, blank: r.blank, words: r.words }),
  );
  const a = r.after;
  check(
    "T10: the clock stops with no line on screen, and the transcript and turn state are put back",
    !!a && a.tick === 0 && !a.line && a.log && a.busy && a.streamId && a.turnId,
    JSON.stringify(a),
  );
}
