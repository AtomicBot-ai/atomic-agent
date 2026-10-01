import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog items 13 and 14 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=13` (or 14).
 *
 * 13 — dark patches flashed in the window while reasoning streamed in.
 * 14 — the inspector lagged while the agent worked, and with Reasoning open
 * it could not be scrolled: it went back to the top on every token.
 *
 * Both came from one render() per streamed token. The probe feeds synthetic
 * frames through the real onChatEvent, on a staged turn (a question and a
 * streaming reply, no agent behind it), and puts back everything it touched.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* The staged turn. `frame()` waits for the next paint, or for the stream's own
   timer when the window is covered and no frames come. Every chunk goes in
   synchronously, the way a burst of IPC messages lands between two frames. */
const STREAM_PROBE = String.raw`(async () => {
  if (S.busy || S.turnId || S.pending || WAIT) return {skipped: 'a turn is live'};
  const frame = () => new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(res, 0); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 1200);
  });
  const saved = {log: S.log, historyLen: S.history.length, room: S.room, inspector: S.inspector, inspTab: S.inspTab,
    stick: S.stick, streamId: S.streamId, reasonId: S.reasonId, queued: S.queued, agentSession: S.agentSession, draft: S.draft,
    plan: {startedMode: PLAN.startedMode, on: PLAN.on, itemId: PLAN.itemId, sessionId: PLAN.sessionId},
    unverified: UNVERIFIED, deferred: DL.deferred, steerAhead: STEER.ahead, steerMine: STEER.mine.slice(), fz: FZ.live};
  const realRender = render;
  let renders = 0;
  const out = {};
  try {
    const turnId = 'smoke-t13-' + Date.now().toString(16);
    const reply = {id: nid(), k: 'assistant', text: ''};
    S.room = 'chat';
    S.log = [{id: nid(), k: 'user', text: 'smoke t13: think out loud for a while'}, reply];
    S.streamId = reply.id; S.turnId = turnId; S.busy = true; S.reasonId = null; S.pending = null;
    S.queued = []; S.agentSession = null; S.stick = true;
    S.inspector = true; S.inspTab = 'reasoning';
    // The end of the turn below must not plan, activate a parked download or clear a key's badge.
    PLAN.startedMode = null; UNVERIFIED = []; DL.deferred = null;
    realRender();
    await frame();
    const body = () => document.querySelector('#inspector .inspbody');
    const well = () => document.querySelector('#inspector .insp-rs .tk-out');
    out.inspOnScreen = !!body() && body().clientHeight > 0;
    render = function () { renders++; return realRender.apply(this, arguments); };
    const comp0 = document.getElementById('composer');
    const ev = (kind, extra) => onChatEvent(Object.assign({turnId, kind}, extra));
    // A leading newline and CRLFs, so the in-place text has to read as the parser reads the markup.
    const chunk = (i) => (i === 0 ? '\n' : '') + 'step ' + i + ': the model weighs the next move, and then the one after it'
      + (i % 7 === 3 ? '\r\n' : '\n');
    const parsed = (t, pre) => { let s = t.replace(/\r\n?/g, '\n'); if (pre && s[0] === '\n') s = s.slice(1); return s; };
    let want = '';
    const think = (from, to) => { for (let i = from; i < to; i++) { const t = chunk(i); want += t; ev('reasoning_progress', {payload: {delta: t}}); } };

    // (a) 200 chunks at once: a frame or two of painting, not 200 renders of the window.
    think(0, 200);
    out.rendersSync = renders;
    await frame();
    out.renders = renders;
    const block = S.log.find((m) => m.k === 'reason');
    out.blockComplete = !!block && block.text === want;
    out.wellComplete = !!well() && well().textContent === parsed(want, true);
    out.rowClosed = !!block && !!document.querySelector('#turn-' + block.id + ' .disc') && !document.querySelector('#turn-' + block.id + ' .discbody');
    out.composerKept = document.getElementById('composer') === comp0;

    // (b) Reasoning open in the inspector and scrolled up: more text does not move it ...
    out.scrollable = body().scrollHeight - body().clientHeight;
    body().scrollTop = 240;
    await frame();
    out.upBefore = body().scrollTop;
    think(200, 260);
    await frame();
    out.upAfter = body().scrollTop;
    // ... nor does a whole render (a tool call starting renders the window) ...
    ev('tool_progress', {payload: {tool: 'os.fs.list', label: '{"path":"."}'}});
    await frame();
    out.upAfterRender = body().scrollTop;
    // ... and at the end it stays at the end while the text grows.
    body().scrollTop = body().scrollHeight;
    await frame();
    const h0 = body().scrollHeight;
    think(260, 320);
    await frame();
    out.endGrew = body().scrollHeight - h0;
    out.endGap = body().scrollHeight - body().scrollTop - body().clientHeight;
    out.wellComplete2 = !!well() && well().textContent === parsed(want, true);
    // The well grown in place and one rebuilt from S.log read the same, to the character.
    const inPlace = well().textContent;
    renderInspector();
    out.sameAsRebuilt = well().textContent === inPlace;
    // Left at the end, the panel shown again — or showing another chat — starts at the top.
    body().scrollTop = body().scrollHeight;
    S.inspector = false; realRender(); S.inspector = true; realRender();
    out.reshownTop = body().scrollTop;
    const staged = S.log;
    body().scrollTop = body().scrollHeight;
    S.log = [{id: nid(), k: 'user', text: 'another chat'}, {id: nid(), k: 'reason', steps: 1, open: false, text: want}];
    realRender();
    out.otherChatTop = body().scrollTop;
    out.otherChatScrollable = body().scrollHeight - body().clientHeight;
    S.log = staged; realRender();

    // An open reasoning row grows in place, through the real click path.
    const rendersBeforeRow = renders;
    document.querySelector('#turn-' + block.id + ' .disc').click();
    const row0 = document.querySelector('#turn-' + block.id + ' .discbody');
    think(320, 360);
    await frame();
    const row1 = document.querySelector('#turn-' + block.id + ' .discbody');
    out.rowOpened = !!row0;
    out.rowGrew = !!row1 && row1.textContent === parsed(want, false);
    out.rowInPlace = !!row0 && row0 === row1;
    out.rowRenders = renders - rendersBeforeRow;

    // The reply: 200 deltas at once, painted into the transcript once per frame.
    const rendersBeforeReply = renders;
    const comp1 = document.getElementById('composer');
    let said = '';
    const say = (from, to) => { for (let i = from; i < to; i++) { const t = 'w' + i + ' '; said += t; ev('delta', {text: t}); } };
    const prose = () => { const p = document.querySelectorAll('#scroller .tk-asst .prose'); return p.length ? p[p.length - 1].textContent.trim() : null; };
    say(0, 200);
    out.replyRendersSync = renders - rendersBeforeReply;
    await frame();
    out.replyRenders = renders - rendersBeforeReply;
    out.replyComplete = prose() === said.trim();
    out.composerKept2 = document.getElementById('composer') === comp1;

    // A steer typed while the reply streams: once Enter empties the box, the button beside it is Stop.
    const entry = document.getElementById('entry');
    entry.value = 'smoke t13 steer'; entry.dispatchEvent(new Event('input', {bubbles: true}));
    const btn = () => { const b = document.querySelector('#composer .sendbtn'); return b ? b.dataset.act + (b.classList.contains('steer') ? ':steer' : '') : null; };
    out.typedButton = btn();
    submit();
    out.sentButton = btn();
    await STEER.chain;
    // No session to ask, so it was parked as the next turn; the staged turn's end must not send it.
    out.parked = S.queued.slice();
    S.queued.length = 0; STEER.ahead = 0;

    // (c) The turn's end paints the final text at once, with a frame still waiting.
    say(200, 230);
    out.pendingBeforeEnd = typeof STREAM_PAINT === 'undefined' ? null : STREAM_PAINT.raf !== 0;
    ev('done', {});
    out.endSync = prose() === said.trim();
    out.endBusy = S.busy;
    out.endPending = typeof STREAM_PAINT === 'undefined' ? null : STREAM_PAINT.raf !== 0;
    await frame();
    out.endAfterFrame = prose() === said.trim();
  } catch (e) {
    out.error = String(e && e.stack || e);
  } finally {
    render = realRender;
    S.log = saved.log; S.history.length = saved.historyLen; S.room = saved.room;
    S.inspector = saved.inspector; S.inspTab = saved.inspTab; S.stick = saved.stick;
    S.streamId = saved.streamId; S.reasonId = saved.reasonId; S.queued = saved.queued; S.agentSession = saved.agentSession;
    S.draft = saved.draft; S.turnId = null; S.busy = false; S.pending = null;
    Object.assign(PLAN, saved.plan); UNVERIFIED = saved.unverified; DL.deferred = saved.deferred;
    STEER.ahead = saved.steerAhead; STEER.mine.length = 0; STEER.mine.push(...saved.steerMine); FZ.live = saved.fz;
    realRender();
    if (typeof refreshContext === 'function') refreshContext();
  }
  return out;
})()`;

/** The page's ground, as the hex the window background is compared with. */
const PAGE_GROUND = String.raw`(() => {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  return m ? '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('') : '';
})()`;

export async function checks13(js: Js, check: Check): Promise<void> {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) ?? null;
  const size = w ? w.getSize() : null;
  const [ow, oh] = size ?? [0, 0];
  try {
    // shell.css does not draw the inspector under 1180px wide; the scroll checks need it on screen.
    if (w && (await js<number>("window.innerWidth")) <= 1200) { w.setSize(1320, Math.max(oh, 760)); await wait(500); }
    const r = await js<Record<string, unknown>>(STREAM_PROBE);
    const ran = !r.skipped && !r.error && r.inspOnScreen === true;
    const detail = JSON.stringify(r);
    if (!ran) process.stdout.write(`DIAG t13 probe ${detail}\n`);

    check(
      "T13: 200 reasoning chunks at once are painted in a frame, with no window render and the composer left alone",
      ran && (r.renders as number) <= 3 && r.composerKept === true && r.blockComplete === true
        && r.wellComplete === true && r.rowClosed === true,
      JSON.stringify({ rendersSync: r.rendersSync, renders: r.renders, composerKept: r.composerKept,
        blockComplete: r.blockComplete, wellComplete: r.wellComplete, rowClosed: r.rowClosed }),
    );
    check(
      "T13: an open reasoning row grows in place",
      ran && r.rowOpened === true && r.rowGrew === true && r.rowInPlace === true && r.rowRenders === 0,
      JSON.stringify({ rowOpened: r.rowOpened, rowGrew: r.rowGrew, rowInPlace: r.rowInPlace, rowRenders: r.rowRenders }),
    );
    check(
      "T13: 200 reply deltas at once land in the transcript in a frame, the composer left alone",
      ran && (r.replyRenders as number) <= 3 && r.replyComplete === true && r.composerKept2 === true,
      JSON.stringify({ replyRendersSync: r.replyRendersSync, replyRenders: r.replyRenders, replyComplete: r.replyComplete,
        composerKept: r.composerKept2 }),
    );
    check(
      "T13: the turn's end paints the final reply at once, taking the waiting frame with it",
      ran && r.pendingBeforeEnd !== false && r.endSync === true && r.endBusy === false && r.endPending !== true
        && r.endAfterFrame === true,
      JSON.stringify({ pendingBeforeEnd: r.pendingBeforeEnd, endSync: r.endSync, endBusy: r.endBusy,
        endPending: r.endPending, endAfterFrame: r.endAfterFrame }),
    );
    check(
      "T14: with Reasoning open and scrolled up, streamed text and a whole render leave the inspector where it was",
      ran && (r.scrollable as number) > 600 && r.upBefore === 240
        && Math.abs((r.upAfter as number) - 240) < 1 && Math.abs((r.upAfterRender as number) - 240) < 1,
      JSON.stringify({ scrollable: r.scrollable, upBefore: r.upBefore, upAfter: r.upAfter, upAfterRender: r.upAfterRender }),
    );
    check(
      "T14: at the end of the reasoning the inspector stays at the end as the text grows",
      ran && (r.endGrew as number) > 0 && (r.endGap as number) < 4 && r.wellComplete2 === true,
      JSON.stringify({ endGrew: r.endGrew, endGap: r.endGap, wellComplete: r.wellComplete2 }),
    );
    check(
      "T14: reasoning painted in place reads exactly as a rebuilt panel (CRLF, a leading newline)",
      ran && r.sameAsRebuilt === true && r.wellComplete === true,
      JSON.stringify({ sameAsRebuilt: r.sameAsRebuilt, wellComplete: r.wellComplete }),
    );
    check(
      "T14: the inspector shown again, or showing another chat, starts at the top",
      ran && r.reshownTop === 0 && r.otherChatTop === 0 && (r.otherChatScrollable as number) > 600,
      JSON.stringify({ reshownTop: r.reshownTop, otherChatTop: r.otherChatTop, otherChatScrollable: r.otherChatScrollable }),
    );
    check(
      "T13: a steer sent while the reply streams puts Stop beside the emptied box at once",
      ran && r.typedButton === "send:steer" && r.sentButton === "stop"
        && JSON.stringify(r.parked) === JSON.stringify(["smoke t13 steer"]),
      JSON.stringify({ typedButton: r.typedButton, sentButton: r.sentButton, parked: r.parked }),
    );

    // 14 — not rebuilt while the window is too narrow to show it; repainted when it widens.
    if (w) {
      const [cw, ch] = w.getSize();
      await js<void>(`(() => {
        window.__t13insp = {inspector: S.inspector, tab: S.inspTab};
        S.inspector = true; S.inspTab = 'steps'; render();
        window.__t13body = document.querySelector('#inspector .inspbody');
      })()`);
      w.setSize(1100, ch);
      await wait(600);
      const narrow = await js<{ matches: boolean; same: boolean }>(`(() => {
        render();
        return {matches: matchMedia('(max-width:1180px)').matches, same: document.querySelector('#inspector .inspbody') === window.__t13body};
      })()`);
      w.setSize(cw, ch);
      await wait(600);
      const wide = await js<{ matches: boolean; rebuilt: boolean; shown: boolean }>(`(() => {
        const b = document.querySelector('#inspector .inspbody');
        return {matches: matchMedia('(max-width:1180px)').matches, rebuilt: !!b && b !== window.__t13body, shown: !!b && b.clientHeight > 0};
      })()`);
      await js<void>(`(() => {
        S.inspector = window.__t13insp.inspector; S.inspTab = window.__t13insp.tab;
        delete window.__t13insp; delete window.__t13body; render();
      })()`);
      check(
        "T14: the inspector is not rebuilt while the window is too narrow to show it, and is repainted when it widens",
        narrow.matches && narrow.same && !wide.matches && wide.rebuilt && wide.shown,
        JSON.stringify({ narrow, wide }),
      );
    }
  } finally {
    if (w && size && !w.isDestroyed()) { w.setSize(ow, oh); await wait(300); }
  }

  // 13 — the window's own background is the page's ground, on either theme.
  if (w) {
    const before = await js<{ theme: string; stored: string | null }>(
      "({theme: S.theme, stored: (() => { try { return localStorage.getItem('atag.theme'); } catch (e) { return null; } })()})",
    );
    const sample = async () => ({ page: await js<string>(PAGE_GROUND), win: w.getBackgroundColor().toLowerCase() });
    const boot = await sample();
    const seen: Record<string, { page: string; win: string }> = { boot };
    for (const theme of ["light", "dark"]) {
      await js<void>(`act('theme:${theme}')`);
      await wait(400);
      seen[theme] = await sample();
    }
    await js<void>(`(() => {
      act('theme:' + ${JSON.stringify(before.theme)});
      try { const v = ${JSON.stringify(before.stored)}; if (v === null) localStorage.removeItem('atag.theme'); else localStorage.setItem('atag.theme', v); } catch (e) { /* no storage */ }
    })()`);
    await wait(300);
    const back = await sample();
    const same = (s: { page: string; win: string } | undefined) => !!s && /^#[0-9a-f]{6}$/.test(s.page) && s.page === s.win;
    check(
      "T13: the window background is the page's ground — at boot, on the light theme and on the dark one",
      same(boot) && same(seen.light) && same(seen.dark) && seen.light!.page !== seen.dark!.page && same(back),
      JSON.stringify({ ...seen, back }),
    );
  }
}
