import { BrowserWindow } from "electron";

/**
 * Release-fix checks for Danya's Settings items (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=49`.
 *
 * Д36 Telegram showed config keys, `.env` and an `unknown` state, and an
 * Advanced toggle whose label changed width under the pointer: before a token
 * it is the Connect Telegram card alone, after it one Connected / Not
 * connected status over rows in words — Connected only with Telegram on and
 * no change still waiting for a restart — with a Check again that reads the
 * tab anew, and a restart's lines that go once the new agent is up.
 * Д39 Memory's empty channels said "No votes yet" and nothing about it.
 * Д40 Tasks had a hole beside its filters: Refresh and New task share their row.
 * Д47 Privacy's read-scope change put a blue line above the rows that pushed
 * them down; it is a toast, and a restart still owed (analytics) stays offered
 * under the rows, in General too. Д48 Session grants was a row with nothing
 * to set; it is a line under the switch. Д49 Analytics sent you to General;
 * the switch is in Privacy too, drawn from the same value. Д50 The two cards
 * of what analytics send are two plain lines under that switch.
 * Д51 Import's Run preview moved with each source and went past the window's
 * edge; it stays in the pane's header, first in the keyboard's order. Д52 it
 * is Preview import, and Limit says what it limits. Д53 the report is in
 * words, Apply is off when there is nothing to import, and the check says
 * Checking…. Д54 Pi and Oh-My-Pi wear a neutral glyph.
 * Д55–Д59 Diagnostics says what it is for, copies values and the log, names
 * its report "Save report for support" (so do the Help menu and the palette),
 * opens the model server's log in place instead of jumping to Models without
 * asking `models status` on every tick, and no longer repeats its rows as a
 * status line. (What the report holds and how it is cleaned is checked by the
 * report's own item, not here.)
 *
 * Panes are drawn into detached elements from staged state where the state
 * would otherwise have to be written (a token, analytics), and on the window
 * where layout or focus is the point. Nothing is written: the read-scope
 * write, the analytics write and the token write are stood in for — the last
 * two on the window's own IPC, relied on only after a probe proves the stand-in
 * answers. Every block puts back what it staged and closes Settings.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };
type Handler = (event: unknown, payload: unknown) => unknown;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown) => JSON.stringify(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STAND_IN = "smoke t49 stand-in";

/* A renderer error is a failed check, never a thrown one (see t09). */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return (await js<T & Failed>(code)) ?? ({ err: "the renderer answered nothing" } as T & Failed);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

/** The app window the smoke drives (the renderer's index.html). */
function appWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\.html$/.test(w.webContents.getURL())) ?? null;
}

/**
 * Runs `body` with `channel` answered by `handler` on the window's own IPC
 * (asked before ipcMain's), after `probe` — a call the real handler refuses
 * without writing anything — has come back with the stand-in's answer.
 * Returns why it did not run, or null.
 */
async function withStandIn(js: Js, channel: string, handler: Handler, probe: string, body: () => Promise<void>): Promise<string | null> {
  const win = appWindow();
  if (!win) return "no app window";
  win.webContents.ipc.removeHandler(channel);
  win.webContents.ipc.handle(channel, handler);
  try {
    const answer = await js<{ error?: string; standIn?: string } | null>(probe).catch((e: unknown): { error?: string; standIn?: string } => ({ error: message(e) }));
    if (!answer || (answer.error !== STAND_IN && answer.standIn !== STAND_IN)) return `the stand-in on ${channel} did not answer the probe: ${show(answer)}`;
    await body();
    return null;
  } finally {
    if (!win.isDestroyed()) win.webContents.ipc.removeHandler(channel);
  }
}

export async function checks49(js: Js, check: Check): Promise<void> {
  try {
    await telegram(js, check);
    await memory(js, check);
    await tasks(js, check);
    await privacy(js, check);
    await importPane(js, check);
    await diagnostics(js, check);
  } finally {
    await safe<void>(js, "window.__settingsClose()");
  }
}

/* Д36: the states the tab can be in, drawn from staged key names, config and agent generations. */
async function telegram(js: Js, check: Check): Promise<void> {
  type State = { status: string | null; line: string; cards: number; rows: number; advanced: boolean; technical: boolean; pairing: boolean;
    children: number; refresh: boolean; notices: Array<{ text: string; restart: boolean }> };
  const r = await safe<Record<"none" | "pairing" | "connected" | "off" | "unknown" | "owed" | "after" | "restarting" | "restartingOwed" | "restarted", State>>(js, `(() => {
    const saved = {keysKnown: TG.keysKnown, dotenv: TG.dotenvKeys, env: TG.envKeys, mode: TG.mode, message: TG.message, msgKind: TG.msgKind,
      msgGen: TG.msgGen, owedGen: TG.owedGen, lastError: TG.lastError, cfg: TG.cfg, keysBusy: TG.keysBusy, live: LIVE_CONFIG};
    const technical = /telegram\\.enabled|ownerUserId|TELEGRAM_BOT_TOKEN|\\.env\\b|\\bunknown\\b/;
    const set = (token, telegram) => { TG.dotenvKeys = token ? ['TELEGRAM_BOT_TOKEN'] : []; LIVE_CONFIG = Object.assign({}, saved.live || {}, {telegram}); };
    const draw = () => {
      const box = document.createElement('div'); box.innerHTML = telegramTab();
      const pane = box.firstElementChild, st = box.querySelector('[data-tg-status]'), d = box.querySelector('.sd-tgstatus .body .d');
      return {status: st ? st.textContent.trim() : null, line: d ? d.textContent.trim() : '', cards: box.querySelectorAll('.sd-tgcard').length,
        rows: box.querySelectorAll('.sd-rows, .sd-tgstatus').length,
        advanced: /Advanced/.test(box.textContent) || !!box.querySelector('[data-act="telegram:advanced"]'),
        technical: technical.test(box.textContent), pairing: /One last step/.test(box.textContent), children: pane ? pane.children.length : -1,
        refresh: !!box.querySelector('.sd-tgstatus [data-act="telegram:refresh"]'),
        notices: [...box.querySelectorAll('.tk-notice')].map((n) => ({text: n.textContent.replace(/\\s+/g, ' ').trim(), restart: !!n.querySelector('[data-act="agent:restart"]')}))};
    };
    try {
      Object.assign(TG, {keysKnown: true, envKeys: [], mode: 'list', message: null, msgKind: 'info', msgGen: AGENT_GEN, owedGen: null, lastError: null, cfg: null, keysBusy: false});
      const out = {};
      set(false, {enabled: false, ownerUserId: null}); out.none = draw();
      set(true, {enabled: true, ownerUserId: null}); out.pairing = draw();
      set(true, {enabled: true, ownerUserId: 4242}); out.connected = draw();
      set(true, {enabled: false, ownerUserId: 4242}); out.off = draw();
      // No telegram.enabled in the file and no effective value read: unknown, which is not on (the schema's default is off).
      set(true, {ownerUserId: 4242}); out.unknown = draw();
      // A change the agent loads at start: owed until a new agent is up (AGENT_GEN moves when one connects).
      set(true, {enabled: true, ownerUserId: 4242});
      tgSetMessage('Telegram turned on.', 'owed'); out.owed = draw();
      TG.owedGen = AGENT_GEN - 1; TG.msgGen = AGENT_GEN - 1; out.after = draw();
      tgSetMessage('Restarting the agent, and the bot with it.', 'restarting'); out.restarting = draw();
      TG.owedGen = AGENT_GEN; out.restartingOwed = draw();
      TG.owedGen = AGENT_GEN - 1; TG.msgGen = AGENT_GEN - 1; out.restarted = draw();
      return out;
    } finally {
      Object.assign(TG, {keysKnown: saved.keysKnown, dotenvKeys: saved.dotenv, envKeys: saved.env, mode: saved.mode, message: saved.message, msgKind: saved.msgKind,
        msgGen: saved.msgGen, owedGen: saved.owedGen, lastError: saved.lastError, cfg: saved.cfg, keysBusy: saved.keysBusy});
      LIVE_CONFIG = saved.live;
    }
  })()`);
  check(
    "T49 (Д36): before a token the Telegram tab is the Connect Telegram card alone — no Advanced, no rows",
    !r.err && r.none.cards === 1 && r.none.children === 1 && r.none.rows === 0 && !r.none.advanced && !r.none.technical && !r.none.refresh,
    r.err ?? show(r.none),
  );
  check(
    "T49 (Д36): with a token, one status in words — Not connected until paired, when off, or when on is unknown; Connected when paired and on — no config keys, .env or unknown",
    !r.err && r.pairing.status === "Not connected" && r.pairing.pairing && r.connected.status === "Connected" && r.off.status === "Not connected"
      && r.unknown.status === "Not connected" && /Turned off/.test(r.unknown.line)
      && [r.pairing, r.connected, r.off, r.unknown].every((s) => !s.technical && !s.advanced && s.rows === 2),
    r.err ?? show({ pairing: r.pairing, connected: r.connected, off: r.off, unknown: r.unknown }),
  );
  check(
    "T49 (Д36): a change waiting for a restart is not Connected, and its one notice offers the restart; once a new agent is up, Connected and no notice",
    !r.err && r.owed.status === "Not connected" && /restart/i.test(r.owed.line) && r.owed.notices.length === 1 && r.owed.notices[0]!.restart
      && /^Telegram turned on\. It takes effect after a restart\./.test(r.owed.notices[0]!.text)
      && r.after.status === "Connected" && r.after.notices.length === 0,
    r.err ?? show({ owed: r.owed, after: r.after }),
  );
  check(
    "T49 (Д36): \"Restarting the agent…\" shows alone while the restart runs, and goes once the new agent is up",
    !r.err && r.restarting.notices.length === 1 && /^Restarting the agent/.test(r.restarting.notices[0]!.text) && !r.restarting.notices[0]!.restart
      && r.restartingOwed.notices.length === 1 && !r.restartingOwed.notices[0]!.restart && r.restarted.notices.length === 0,
    r.err ?? show({ restarting: r.restarting.notices, restartingOwed: r.restartingOwed.notices, restarted: r.restarted.notices }),
  );

  // Check again: in every state with a token, and it reads the tab anew (the R key's refresh).
  const again = await safe<{ calls: number }>(js, `(() => {
    const real = tgRefresh, busy = TG.keysBusy;
    let calls = 0;
    try { tgRefresh = () => { calls++; return Promise.resolve(); }; telegramAct('refresh'); return {calls}; }
    finally { tgRefresh = real; TG.keysBusy = busy; }
  })()`);
  check(
    "T49 (Д36): with a token the status carries Check again, and it reads the tab anew",
    !r.err && r.pairing.refresh && r.connected.refresh && r.off.refresh && !again.err && again.calls === 1,
    r.err ?? again.err ?? show({ refresh: [r.pairing.refresh, r.connected.refresh, r.off.refresh], calls: again.calls }),
  );

  // A token the write refuses: said once, under the field — not again as the tab's error line.
  type Saved = { ok: boolean; tokenError: string | null; lastError: string | null; shown: number };
  let failed: Partial<Saved> & Failed = {};
  const why = await withStandIn(js, "app:dotenvSet", () => ({ ok: false, error: STAND_IN }),
    "BR.dotenvSet('/nonexistent-smoke-t49', 'SMOKE_T49_PROBE', null)", async () => {
      failed = await safe<Saved>(js, `(async () => {
        const saved = {mode: TG.mode, token: TG.token, lastError: TG.lastError, busy: TG.busy};
        try {
          Object.assign(TG, {mode: 'tokenPrompt', token: {error: null, submitting: false}, lastError: null});
          const res = await tgTokenSave('smoke-t49-not-a-token');
          const box = document.createElement('div'); box.innerHTML = telegramTab();
          return {ok: res.ok, tokenError: TG.token.error, lastError: TG.lastError, shown: (box.textContent.match(/Could not save the token/g) || []).length};
        } finally { Object.assign(TG, saved); }
      })()`);
    });
  check(
    "T49 (Д36): a token the write refuses is said once, under the field, not twice",
    why === null && !failed.err && failed.ok === false && /^Could not save the token: smoke t49 stand-in/.test(failed.tokenError ?? "")
      && failed.lastError === null && failed.shown === 1,
    why ?? failed.err ?? show(failed),
  );
}

/* Д39: every channel's empty state says what would be in it, and a search that found nothing says so. */
async function memory(js: Js, check: Check): Promise<void> {
  type Empty = { title: string; line: string };
  const r = await safe<{ channels: Record<string, Empty>; searched: Empty }>(js, `(() => {
    const saved = {mode: MEM.mode, channel: MEM.channel, rows: MEM.rows, hint: MEM.channelHint, at: MEM.lastRefreshedAt, search: MEM.search};
    const read = () => { const box = document.createElement('div'); box.innerHTML = memListHTML();
      const h = box.querySelector('.tk-empty h4'), p = box.querySelector('.tk-empty p');
      return {title: h ? h.textContent : '', line: p ? p.textContent.trim() : ''}; };
    try {
      Object.assign(MEM, {mode: 'list', rows: [], channelHint: null, lastRefreshedAt: Date.now(), search: ''});
      const channels = {};
      for (const ch of MEM_CHANNEL_ORDER) { MEM.channel = ch; channels[ch] = read(); }
      MEM.channel = 'notes'; MEM.search = 'zzz-smoke-t49';
      return {channels, searched: read()};
    } finally {
      Object.assign(MEM, {mode: saved.mode, channel: saved.channel, rows: saved.rows, channelHint: saved.hint, lastRefreshedAt: saved.at, search: saved.search});
    }
  })()`);
  const lines: Empty[] = r.err || !r.channels ? [] : Object.values(r.channels);
  const votes = r.err || !r.channels ? undefined : r.channels["votes"];
  check(
    "T49 (Д39): No votes yet says what votes are, and every empty Memory channel says what would be in it",
    !r.err && votes?.title === "No votes yet" && /rates the memories it used/.test(votes?.line ?? "")
      && lines.length === 6 && lines.every((v) => v.line.length > 20),
    r.err ?? show(r.channels),
  );
  check(
    "T49 (Д39): a search that found nothing says Nothing matches, not that the channel is empty",
    !r.err && r.searched?.title === "Nothing matches “zzz-smoke-t49”",
    r.err ?? show(r.searched),
  );
}

/* Д40: Refresh and New task on the filters' row, measured on the window at its default width and at its narrowest. */
async function tasks(js: Js, check: Check): Promise<void> {
  const win = appWindow();
  if (!win) { check("T49 (Д40): Tasks' actions sit beside its filters", false, "no app window"); return; }
  type Bar = { sameRow: boolean; level: number; pairLevel: number; rightGap: number; inside: boolean; width: number };
  const MEASURE = `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const saved = {mode: TK.mode, searchOpen: TK.searchOpen};
    try {
      TK.mode = 'list'; TK.searchOpen = false;
      window.__settingsOpen('tasks'); await tick(200);
      const bar = document.querySelector('#settings .setbody .set-toolbar');
      const seg = bar && bar.querySelector('.set-seg');
      const nw = bar && bar.querySelector('[data-act="tasks:new"]'), rf = bar && bar.querySelector('[data-act="tasks:refresh"]');
      if (!seg || !nw || !rf) return {err: 'the toolbar, its filters or its buttons are not drawn'};
      const r = (e) => e.getBoundingClientRect(), mid = (e) => (r(e).top + r(e).bottom) / 2;
      return {sameRow: seg.closest('.set-tbrow') === nw.closest('.set-tbrow') && rf.closest('.set-tbrow') === nw.closest('.set-tbrow'),
        level: Math.round(Math.abs(mid(seg) - mid(nw))), pairLevel: Math.round(Math.abs(mid(rf) - mid(nw))),
        rightGap: Math.round(r(bar).right - r(nw).right), inside: r(rf).left >= r(bar).left && r(nw).right <= r(bar).right + 1, width: window.innerWidth};
    } finally { Object.assign(TK, saved); window.__settingsClose(); }
  })()`;
  const size = win.getContentSize();
  try {
    win.setContentSize(1280, size[1]!);
    await wait(500);
    const wide = await safe<Bar>(js, MEASURE);
    check(
      "T49 (Д40): on the default-width window, Refresh and New task stand at the right end of the filters' row — no hole beside the filters",
      !wide.err && wide.sameRow && wide.level <= 3 && wide.pairLevel <= 3 && wide.rightGap <= 1 && wide.inside,
      wide.err ?? show(wide),
    );
    win.setContentSize(940, size[1]!);
    await wait(500);
    const narrow = await safe<Bar>(js, MEASURE);
    check(
      "T49 (Д40): on the narrowest window the pair stays together, on the right, inside the toolbar",
      !narrow.err && narrow.sameRow && narrow.pairLevel <= 3 && narrow.rightGap <= 1 && narrow.inside,
      narrow.err ?? show(narrow),
    );
  } finally {
    const now = win.getContentSize();
    if (now[0] !== size[0] || now[1] !== size[1]) { win.setContentSize(size[0]!, size[1]!); await wait(400); }
  }
}

/* Д47–Д50. */
async function privacy(js: Js, check: Check): Promise<void> {
  const pane = await safe<{ switches: number; toGeneral: boolean; grants: boolean; grantLine: boolean; cards: number; icons: number;
    lines: string[]; leaves: boolean }>(js, `(() => {
    const box = document.createElement('div'); box.innerHTML = privacyPane();
    const sw = box.querySelector('.tk-switch[data-act="privacy:analytics"]'), row = sw && sw.closest('.tk-setrow');
    return {switches: box.querySelectorAll('.tk-switch[data-act="privacy:analytics"]').length,
      toGeneral: !!box.querySelector('[data-act="settings:general"]') || /Open General|on or off in General/.test(box.textContent),
      grants: /Session grants/.test(box.textContent), grantLine: /read that folder for the rest of the chat/.test(box.textContent),
      cards: box.querySelectorAll('.set-privgrid, .set-privcol').length, icons: row ? row.querySelectorAll('.tk-ico').length : -1,
      lines: row ? [...row.querySelectorAll('.set-privline')].map((p) => p.textContent.trim()) : [],
      leaves: /never leaves/i.test(box.textContent)};
  })()`);
  check(
    "T49 (Д48): Session grants is no longer a row with nothing to set, but one line under the read-scope switch",
    !pane.err && !pane.grants && pane.grantLine,
    pane.err ?? show(pane),
  );
  check(
    "T49 (Д50): what analytics send is two plain lines under the analytics switch, not two cards, worded Sent / Never sent with analytics",
    !pane.err && pane.cards === 0 && pane.icons === 0 && pane.lines.length === 2
      && pane.lines[0] === "Sent with analytics: an install id, coarse counters, crash reports."
      && pane.lines[1] === "Never sent with analytics: message content, paths, tool arguments, IP address." && !pane.leaves,
    pane.err ?? show({ cards: pane.cards, icons: pane.icons, lines: pane.lines }),
  );

  // Д49: the switch is here, the same one as General's, and both show the same value.
  const sync = await safe<{ rows: Array<{ want: string; privacy: string | null; general: string | null }> }>(js, `(() => {
    const saved = LIVE_CONFIG;
    try {
      const rows = [true, false].map((v) => {
        LIVE_CONFIG = Object.assign({}, saved || {}, {analytics: Object.assign({}, (saved && saved.analytics) || {}, {enabled: v})});
        const read = (html) => { const box = document.createElement('div'); box.innerHTML = html;
          const sw = box.querySelector('.tk-switch[data-act="privacy:analytics"]'); return sw ? sw.getAttribute('aria-checked') : null; };
        return {want: String(v), privacy: read(privacyPane()), general: read(generalPane())};
      });
      return {rows};
    } finally { LIVE_CONFIG = saved; }
  })()`);
  check(
    "T49 (Д49): Privacy carries the analytics switch itself (no Open General), and it always agrees with General's",
    !pane.err && pane.switches === 1 && !pane.toGeneral && !sync.err && sync.rows.length === 2
      && sync.rows.every((x) => x.privacy === x.want && x.general === x.want),
    pane.err ?? sync.err ?? show({ switches: pane.switches, toGeneral: pane.toGeneral, rows: sync.rows }),
  );

  /* Д47: a read-scope change the agent takes at once. The write is stood in
     for (configPatchOr answers live, nothing is written), so the config the
     next read brings back is the one that was there. Toasts are told apart by
     id: one may expire while the check runs. */
  const live = await safe<{ skipped?: string; calls: number; top0: number | null; top1: number | null; notices: number; toast: string | null }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    for (let i = 0; i < 100 && (PRIV.busy || PRIV.pending); i++) await tick(100);
    if (!LIVE_CONFIG || PRIV.busy || PRIV.pending) return {skipped: 'no config read yet, or a privacy write still in flight after 10 s'};
    const realPatch = configPatchOr, lastToast = S.toastId;
    // A restart offer an earlier write left (analytics) is put aside, so the page starts as a person meets it.
    const notes = {owed: PRIV.owed, owedGen: PRIV.owedGen, lastError: PRIV.lastError};
    let calls = 0;
    try {
      Object.assign(PRIV, {owed: {}, owedGen: null, lastError: null});
      window.__settingsOpen('privacy'); await tick(250);
      const row = () => document.querySelector('#settings .setbody .set-privacy .tk-setrow');
      const top0 = row() ? Math.round(row().getBoundingClientRect().top) : null;
      configPatchOr = async () => { calls++; return {ok: true, live: true}; };
      await readScopeSet(readScopeValue() === 'unrestricted' ? 'working-dir' : 'unrestricted');
      await tick(150);
      const top1 = row() ? Math.round(row().getBoundingClientRect().top) : null;
      return {calls, top0, top1, notices: document.querySelectorAll('#settings .setbody .set-privacy .tk-notice--blue').length,
        toast: (S.toasts.filter((t) => t.id > lastToast).map((t) => t.t).pop()) || null};
    } finally {
      configPatchOr = realPatch;
      Object.assign(PRIV, notes);
      S.toasts = S.toasts.filter((t) => t.id <= lastToast); renderToasts();
      window.__settingsClose();
    }
  })()`);
  check(
    "T49 (Д47): switching Ask first / Read anywhere says so in a toast and moves nothing on the page",
    !live.err && !live.skipped && live.calls === 1 && live.top0 !== null && live.top0 === live.top1 && live.notices === 0
      && typeof live.toast === "string" && /^The agent will (ask before reading|read anywhere)/.test(live.toast),
    live.err ?? live.skipped ?? show(live),
  );

  /* Д47: the restart an analytics write owes stays offered through a
     read-scope change, live or not, and is drawn under General's rows too;
     it goes once a new agent is up. */
  const kept = await safe<{ skipped?: string; afterLive: string; afterNotLive: string; generalBelow: boolean; afterRestart: string }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    for (let i = 0; i < 100 && (PRIV.busy || PRIV.pending); i++) await tick(100);
    if (!LIVE_CONFIG || PRIV.busy || PRIV.pending) return {skipped: 'no config read yet, or a privacy write still in flight after 10 s'};
    const realPatch = configPatchOr, lastToast = S.toastId;
    const notes = {owed: PRIV.owed, owedGen: PRIV.owedGen, lastError: PRIV.lastError};
    const other = () => (readScopeValue() === 'unrestricted' ? 'working-dir' : 'unrestricted');
    try {
      Object.assign(PRIV, {owed: {}, owedGen: null, lastError: null});
      privOwe('analytics', 'analytics disabled');
      configPatchOr = async () => ({ok: true, live: true});
      await readScopeSet(other());
      const afterLive = privOwedText();
      configPatchOr = async () => ({ok: true, live: false});
      await readScopeSet(other());
      const afterNotLive = privOwedText();
      const g = document.createElement('div'); g.innerHTML = generalPane();
      const list = g.querySelector('.tk-list'), offer = g.querySelector('[data-act="agent:restart"]');
      const generalBelow = !!list && !!offer && !list.contains(offer) && !!(list.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING);
      PRIV.owedGen = AGENT_GEN - 1;
      return {afterLive, afterNotLive, generalBelow, afterRestart: privOwedText()};
    } finally {
      configPatchOr = realPatch;
      Object.assign(PRIV, notes);
      S.toasts = S.toasts.filter((t) => t.id <= lastToast); renderToasts();
    }
  })()`);
  check(
    "T49 (Д47): a restart analytics still needs stays offered through a read-scope change, under General's rows too, until a new agent is up",
    !kept.err && !kept.skipped && kept.afterLive === "analytics disabled" && /analytics disabled/.test(kept.afterNotLive)
      && /the agent will (ask before reading|read anywhere)/.test(kept.afterNotLive) && kept.generalBelow && kept.afterRestart === "",
    kept.err ?? kept.skipped ?? show(kept),
  );

  // ... and the other way round: an analytics write keeps a read-scope restart offer. The write is stood in for on the window's IPC.
  let both: { text?: string } & Failed = {};
  type Both = { text: string };
  const why = await withStandIn(js, "cli:configSet", () => ({ ok: true, stdout: "", stderr: "", standIn: STAND_IN }),
    "BR.configSet('smoke t49 probe', 'x')", async () => {
      both = await safe<Both>(js, `(async () => {
        const tick = (ms) => new Promise((res) => setTimeout(res, ms));
        for (let i = 0; i < 100 && (PRIV.busy || PRIV.pending); i++) await tick(100);
        const notes = {owed: PRIV.owed, owedGen: PRIV.owedGen, lastError: PRIV.lastError};
        try {
          Object.assign(PRIV, {owed: {}, owedGen: null, lastError: null});
          privOwe('readScope', 'the agent will read anywhere without asking');
          const eff = privacyEffective();
          await privacySet(eff === null ? false : !eff);
          return {text: privOwedText()};
        } finally { Object.assign(PRIV, notes); }
      })()`);
    });
  await safe<void>(js, "privacyRefresh()");
  check(
    "T49 (Д47): an analytics write keeps the read-scope restart offer and adds its own",
    why === null && !both.err && /the agent will read anywhere without asking/.test(both.text ?? "") && /analytics (enabled|disabled)/.test(both.text ?? ""),
    why ?? both.err ?? show(both),
  );
}

/* Д51–Д54. */
async function importPane(js: Js, check: Check): Promise<void> {
  type Pos = { top: number; left: number; right: number; inView: boolean; label: string; ringRoom: number } | null;
  const r = await safe<{ pos: Record<string, Pos>; scrolled: Pos; label: string; placeholder: string; marks: Record<string, boolean>; generic: boolean[];
    oldRun: boolean; order: string }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const saved = {mode: IMP.mode, form: Object.assign({}, IMP.form), report: IMP.report, notice: IMP.notice, state: IMP.state};
    const at = () => {
      const b = document.querySelector('#settings .setbody [data-act="import:preview"]'), body = document.querySelector('#settings .setbody');
      if (!b || !body) return null;
      const r = b.getBoundingClientRect(), v = body.getBoundingClientRect();
      return {top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), label: b.textContent.trim(),
        inView: r.top >= v.top - 1 && r.bottom <= v.bottom + 1 && r.left >= v.left - 1 && r.right <= v.right + 1,
        ringRoom: Math.round(r.top - v.top)};
    };
    try {
      Object.assign(IMP, {mode: 'configure', report: null, notice: null});
      window.__settingsOpen('import'); await tick(250);
      const pos = {};
      for (const src of IMP_SOURCES) { importAct('source:' + src); await tick(80); pos[src] = at(); }
      // The longest form, scrolled to its end: the button is still on screen.
      importAct('source:claude-code'); await tick(80);
      const body = document.querySelector('#settings .setbody');
      if (body) { body.scrollTop = body.scrollHeight; await tick(80); }
      const scrolled = at();
      if (body) body.scrollTop = 0;
      const lbl = document.querySelector('#settings .setbody label[for="imp-limit"]'), inp = document.getElementById('imp-limit');
      const marks = {}, generic = [];
      for (const src of IMP_SOURCES) {
        const btn = document.querySelector('#settings .setbody [data-act="import:source:' + src + '"]');
        marks[src] = !!btn && !!btn.querySelector('.logo, .tk-ico');
        if (src === 'pi' || src === 'oh-my-pi') { const g = btn && btn.querySelector('.tk-ico'); generic.push(!!g && !!g.querySelector('svg') && !g.querySelector('img')); }
      }
      return {pos, scrolled, label: lbl ? lbl.textContent.trim() : '', placeholder: inp ? inp.getAttribute('placeholder') : '', marks, generic,
        oldRun: !!document.querySelector('#settings .sd-run'), order: impFocusOrder('codex').join(',')};
    } finally {
      Object.assign(IMP, {mode: saved.mode, report: saved.report, notice: saved.notice, state: saved.state});
      Object.assign(IMP.form, saved.form);
      window.__settingsClose();
    }
  })()`);
  const spots = r.err ? [] : Object.values(r.pos);
  const first = spots[0];
  check(
    "T49 (Д51): Preview import keeps one place on screen whatever the source, and stays in view at the end of the longest form",
    !r.err && spots.length === 6 && !!first && spots.every((p) => !!p && p.inView && p.top === first?.top && p.left === first?.left && p.right === first?.right)
      && !!r.scrolled && r.scrolled.inView && !r.oldRun,
    r.err ?? show({ pos: r.pos, scrolled: r.scrolled, oldRun: r.oldRun }),
  );
  check(
    "T49 (Д51): the keyboard reaches Preview import first, as it stands above the form, with room for its focus ring",
    !r.err && r.order.startsWith("run,sourceType,") && !r.order.endsWith(",run") && !!first && first.ringRoom >= 4,
    r.err ?? show({ order: r.order, ringRoom: first?.ringRoom }),
  );
  check(
    "T49 (Д52): the button is Preview import, and the limit says it is the sessions to import, All when empty",
    !r.err && !!first && first.label === "Preview import" && r.label === "Sessions to import" && r.placeholder === "All",
    r.err ?? show({ label: first?.label, limit: r.label, placeholder: r.placeholder }),
  );
  check(
    "T49 (Д54): every import source wears a mark — Pi and Oh-My-Pi a neutral glyph, not a made-up logo",
    !r.err && Object.values(r.marks).length === 6 && Object.values(r.marks).every(Boolean) && r.generic.length === 2 && r.generic.every(Boolean),
    r.err ?? show({ marks: r.marks, generic: r.generic }),
  );

  // Д53: the report, the check's words, and Apply with nothing to import.
  const rep = await safe<{ caption: boolean; dry: boolean; sum: string; sum2: string; outcome2: string; back: string | null; doneBack: string | null;
    applyOff: boolean; apply2On: boolean; ranNothing: number; ranSome: number; checking: string; importing: string }>(js, `(() => {
    const saved = {mode: IMP.mode, report: IMP.report, state: IMP.state, busy: IMP.busy, applying: IMP.applying, notice: IMP.notice};
    const realRun = impRun;
    let ran = 0;
    const draw = (html) => { const box = document.createElement('div'); box.innerHTML = html; return box; };
    try {
      Object.assign(IMP, {state: 'preview', busy: false, notice: null});
      const none = {items: [{kind: 'sessions', status: 'skipped', source: 'smoke-t49', reason: 'nothing there'}, {kind: 'cron', status: 'skipped', source: 'smoke-t49b'}],
        summary: {migrated: 0, skipped: 2, conflict: 0, error: 0}};
      const some = {items: [{kind: 'skills', status: 'migrated', source: 'smoke-t49'}, {kind: 'skills', status: 'conflict', source: 'smoke-t49b'}],
        summary: {migrated: 1, skipped: 0, conflict: 1, error: 0}};
      const a = draw(impReportHTML(none, false)), b = draw(impReportHTML(some, false)), c = draw(impReportHTML(none, true));
      const apply = a.querySelector('[data-act="import:apply"]'), apply2 = b.querySelector('[data-act="import:apply"]');
      impRun = async () => { ran++; return {ok: true}; };
      Object.assign(IMP, {mode: 'preview', report: none}); importAct('apply');
      const ranNothing = ran;
      Object.assign(IMP, {mode: 'preview', report: some}); importAct('apply');
      const ranSome = ran - ranNothing;
      Object.assign(IMP, {mode: 'running', report: null, applying: false});
      const checking = draw(importTab()).textContent;
      IMP.applying = true;
      const importing = draw(importTab()).textContent;
      return {caption: /Nothing is changed yet/.test(a.textContent), dry: /dry run/.test(a.textContent),
        sum: (a.querySelector('.sd-sum') || {}).textContent || '', sum2: (b.querySelector('.sd-sum') || {}).textContent || '',
        outcome2: ((b.querySelector('[data-import-row] td .tk-chip') || {}).textContent || '').trim(),
        back: ((a.querySelector('[data-act="import:reset"]') || {}).textContent || '').trim() || null,
        doneBack: ((c.querySelector('[data-act="import:reset"]') || {}).textContent || '').trim() || null,
        applyOff: !!apply && apply.disabled, apply2On: !!apply2 && !apply2.disabled, ranNothing, ranSome, checking, importing};
    } finally {
      impRun = realRun;
      Object.assign(IMP, saved);
    }
  })()`);
  check(
    "T49 (Д53): the preview reads Nothing is changed yet and \"0 will be imported, 2 skipped\", Edit is Back, a migrated row will import",
    !rep.err && rep.caption && !rep.dry && rep.sum === "0 will be imported, 2 skipped" && rep.sum2 === "1 will be imported, 0 skipped, 1 conflict"
      && rep.outcome2 === "will import" && rep.back === "Back" && rep.doneBack === "Back",
    rep.err ?? show(rep),
  );
  check(
    "T49 (Д53): Apply is off, and y / Enter do nothing, when the preview found nothing to import; with something to import it runs",
    !rep.err && rep.applyOff && rep.apply2On && rep.ranNothing === 0 && rep.ranSome === 1,
    rep.err ?? show({ applyOff: rep.applyOff, apply2On: rep.apply2On, ranNothing: rep.ranNothing, ranSome: rep.ranSome }),
  );
  check(
    "T49 (Д53): the preview's run says Checking…, Apply's says Importing…, never \"importing… please wait\"",
    !rep.err && /Checking…/.test(rep.checking) && !/Importing…/.test(rep.checking) && /Importing…/.test(rep.importing)
      && !/please wait/i.test(rep.checking + rep.importing),
    rep.err ?? show({ checking: rep.checking, importing: rep.importing }),
  );
}

/* Д55–Д59. */
async function diagnostics(js: Js, check: Check): Promise<void> {
  const r = await safe<{ intro: string; rows: number; withValue: number; buttons: number; copied: Array<{ text: string; title: string }>; shown: string;
    allHasRows: boolean; allHasLine: boolean; save: string; menu: string | null; palette: string | null; statusLine: boolean; jump: boolean;
    pane: string | null; logOpen: boolean; modelsLog: boolean; logState: string }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const saved = {open: DIAG.logOpen, copy: copyText, lastToast: S.toastId, view: LLMP.view};
    const copied = [];
    try {
      DIAG.logOpen = false;
      window.__settingsOpen('diagnostics'); await tick(250);
      const pane = document.querySelector('#settings .setbody .set-diag');
      if (!pane) return {err: 'Diagnostics is not drawn'};
      const rows = [...pane.querySelectorAll('.set-diagrow')];
      const valued = rows.filter((row) => ((row.querySelector('.set-diagv') || {}).textContent || '—') !== '—');
      copyText = (text, title) => { copied.push({text: String(text), title: title || ''}); return Promise.resolve(true); };
      const btn = pane.querySelector('[data-act^="diag:copy:"]');
      const shown = btn ? btn.closest('.set-diagrow').querySelector('.set-diagv').textContent : '';
      if (btn) btn.click();
      const all = pane.querySelector('[data-act="diag:copyall"]');
      if (all) all.click();
      const allText = copied.length > 1 ? copied[copied.length - 1].text : '';
      const dumpNode = window.__menuNodes().find((n) => n.id === 'help.dump');
      const palRow = PAL.flatMap((g) => g[1]).find((row) => row[4] === 'dump');
      const out = {intro: ((pane.querySelector('.set-diagintro') || {}).textContent || '').trim(), rows: rows.length, withValue: valued.length,
        buttons: valued.filter((row) => !!row.querySelector('[data-act^="diag:copy:"]')).length, copied: copied.slice(), shown,
        allHasRows: rows.every((row) => allText.includes(row.querySelector('.t').textContent + ': ')), allHasLine: / \\| approval L/.test(allText),
        save: ((pane.querySelector('[data-act="dump"]') || {}).textContent || '').trim(),
        menu: dumpNode ? dumpNode.label : null, palette: palRow ? palRow[1] : null,
        statusLine: /Status line/.test(pane.textContent) || !!pane.querySelector('.set-diagline'),
        jump: !!pane.querySelector('[data-act="diag:llmlogs"]')};
      // The verb Models › LLM logs uses, from a closed window: it lands here, with the log open.
      window.__settingsClose();
      act('diag:llmlogs');
      let state = '';
      // models status may have to answer first (the log's folder is in it): up to 15 s.
      for (let i = 0; i < 150 && !state; i++) {
        await tick(100);
        const log = document.querySelector('#settings .setbody .set-diag .set-diaglog.on');
        if (!log) continue;
        if (log.querySelector('pre.set-log')) state = 'lines';
        else if (/No log yet|You run this model server yourself/.test(log.textContent)) state = 'empty';
        else if (log.querySelector('.tk-notice')) state = 'error';
      }
      out.pane = window.__settingsPane();
      out.logOpen = !!document.querySelector('#settings .setbody .set-diag .set-diaglog.on');
      out.modelsLog = LLMP.view === 'logs';
      out.logState = state;
      return out;
    } finally {
      copyText = saved.copy;
      DIAG.logOpen = saved.open; diagLogStop();
      if (LLMP.view === 'logs' && saved.view !== 'logs') { if (typeof llmStopLogs === 'function') llmStopLogs(); LLMP.view = saved.view; }
      S.toasts = S.toasts.filter((t) => t.id <= saved.lastToast); renderToasts();
      window.__settingsClose();
    }
  })()`);
  check(
    "T49 (Д55): under the title, one line says what Diagnostics is for",
    !r.err && r.intro === "If something breaks, save a report and send it to us so we can fix it.",
    r.err ?? show(r.intro),
  );
  check(
    "T49 (Д56): every value has its own Copy and it copies what the row shows; Copy details takes every row and the status line",
    !r.err && r.withValue > 0 && r.buttons === r.withValue && r.copied.length === 2 && r.copied[0]!.text === r.shown
      && r.allHasRows && r.allHasLine,
    r.err ?? show({ rows: r.rows, withValue: r.withValue, buttons: r.buttons, copied: r.copied.map((c) => c.title), shown: r.shown, allHasRows: r.allHasRows, allHasLine: r.allHasLine }),
  );
  check(
    "T49 (Д57): Write debug bundle is Save report for support — on the Diagnostics button, in the Help menu and in the palette",
    !r.err && r.save === "Save report for support" && r.menu === "Save report for support" && r.palette === "Save report for support",
    r.err ?? show({ save: r.save, menu: r.menu, palette: r.palette }),
  );
  check(
    "T49 (Д58): the model server's log opens in Diagnostics, not Models — from the verb Models › LLM logs uses — and is read there",
    !r.err && !r.jump && r.pane === "diagnostics" && r.logOpen && !r.modelsLog && r.logState !== "",
    r.err ?? show({ jump: r.jump, pane: r.pane, logOpen: r.logOpen, modelsLog: r.modelsLog, logState: r.logState }),
  );
  check(
    "T49 (Д59): the status line that repeated the rows is gone from the screen",
    !r.err && !r.statusLine,
    r.err ?? show({ statusLine: r.statusLine }),
  );

  /* Д58: the log's poll never turns into a `models status` spawn every 2 s:
     a failed status is asked once, an external route (no data dir) never,
     Refresh asks once per press; an unchanged read repaints only for Refresh. */
  const poll = await safe<{ failed: { calls: number; error: string | null }; external: { calls: number; external: boolean }; pressed: number; quiet: number; forced: number }>(js, `(async () => {
    const saved = {status: LLMP.status, statusErr: LLMP.statusErr, open: DIAG.logOpen, log: DIAG.log, asked: DIAG.statusAsked, ask: llmRefreshStatus, repaint: diagRepaint};
    let calls = 0, repaints = 0;
    try {
      diagLogStop();
      llmRefreshStatus = async () => { calls++; };
      diagRepaint = () => { repaints++; };
      Object.assign(DIAG, {logOpen: true, log: null, statusAsked: false});
      Object.assign(LLMP, {status: null, statusErr: 'smoke t49: status refused'});
      for (let i = 0; i < 4; i++) await diagLogRefresh();
      const failed = {calls, error: DIAG.log && DIAG.log.error};
      calls = 0; DIAG.statusAsked = false; Object.assign(LLMP, {status: {mode: 'external', dataDir: null}, statusErr: null});
      for (let i = 0; i < 4; i++) await diagLogRefresh();
      const external = {calls, external: !!(DIAG.log && DIAG.log.external)};
      calls = 0; DIAG.statusAsked = false;
      await diagLogRefresh(true); await diagLogRefresh();
      const pressed = calls;
      repaints = 0; await diagLogRefresh(); const quiet = repaints;
      await diagLogRefresh(true); const forced = repaints - quiet;
      return {failed, external, pressed, quiet, forced};
    } finally {
      llmRefreshStatus = saved.ask; diagRepaint = saved.repaint;
      Object.assign(LLMP, {status: saved.status, statusErr: saved.statusErr});
      Object.assign(DIAG, {logOpen: saved.open, log: saved.log, statusAsked: saved.asked});
      diagLogStop();
    }
  })()`);
  check(
    "T49 (Д58): the log's poll asks models status at most once — a failed answer is not retried every 2 s, an external route is never asked",
    !poll.err && poll.failed.calls === 1 && /smoke t49: status refused/.test(poll.failed.error ?? "") && poll.external.calls === 0 && poll.external.external,
    poll.err ?? show(poll),
  );
  check(
    "T49 (Д58): Refresh asks once per press and repaints even when the file is the same; a tick that finds it the same does not",
    !poll.err && poll.pressed === 1 && poll.quiet === 0 && poll.forced === 1,
    poll.err ?? show({ pressed: poll.pressed, quiet: poll.quiet, forced: poll.forced }),
  );

  // Д58: the toggle keeps the keyboard focus; leaving Diagnostics closes the log and stops its poll.
  const focus = await safe<{ opened: boolean; keptOpen: boolean; closed: boolean; keptClose: boolean; leftOpen: boolean; leftTimer: boolean }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const saved = DIAG.logOpen;
    const focused = () => { const a = document.activeElement; return !!a && !!a.dataset && a.dataset.act === 'diag:log'; };
    try {
      DIAG.logOpen = false;
      window.__settingsOpen('diagnostics'); await tick(200);
      const btn = document.querySelector('#settings .setbody [data-act="diag:log"]');
      if (!btn) return {err: 'no log toggle on Diagnostics'};
      btn.focus(); btn.click(); await tick(100);
      const opened = DIAG.logOpen, keptOpen = focused();
      document.activeElement.click(); await tick(100);
      const closed = !DIAG.logOpen, keptClose = focused();
      DIAG.logOpen = true; diagRepaint(); await tick(100);
      window.__settingsOpen('general'); await tick(2600);
      return {opened, keptOpen, closed, keptClose, leftOpen: DIAG.logOpen, leftTimer: !!DIAG.logTimer};
    } finally { DIAG.logOpen = saved; diagLogStop(); window.__settingsClose(); }
  })()`);
  check(
    "T49 (Д58): opening and closing the log keeps the focus on its toggle, and leaving Diagnostics closes it and stops its poll",
    !focus.err && focus.opened && focus.keptOpen && focus.closed && focus.keptClose && !focus.leftOpen && !focus.leftTimer,
    focus.err ?? show(focus),
  );
}
