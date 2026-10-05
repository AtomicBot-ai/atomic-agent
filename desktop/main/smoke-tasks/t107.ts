import { BrowserWindow } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { llamaLogTail } from "../agent-cli.js";
import { managedDataDir } from "../local-llama-key.js";
import { DESKTOP_STATE_DIR } from "../state-dir.js";

/**
 * Release-fix checks (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=107`. Leftovers of 06.10:
 *
 * ATO-193 — Tasks › New with a one-shot `at` time said, in the preview and in
 * the success toast, that agent 0.5.4 stores no next run and fires the task at
 * its next tick, while the list showed the right Next run. Since ATO-133 the
 * agent keeps the time; the caveat is gone.
 *
 * ATO-195 — Diagnostics' model server log took its folder only from `models
 * status`, and with no answer yet (a status call on its way, or one that
 * failed) it had no path and said there was no log. Main now reads the
 * managed folder itself when the renderer names none.
 *
 * ATO-196 — the Memory tab said it refreshes every 5 s and did not: a tick
 * dropped the read before it, coming back to the tab showed old rows, and a
 * window brought back to the front did not read again.
 *
 * ATO-187 — "Waiting for your approval · Jump to request" stood over the
 * composer with the card in full view. Jump is drawn only while the card is
 * out of view; the words stay.
 *
 * Nothing reaches the agent and nothing is written. The task create, the log
 * read and the memory reads are answered by stand-ins on the window's own IPC
 * (a webContents handler is asked before ipcMain's; a probe proves it first,
 * as in t64 and t106) and recorded; the task preview is main's own validator.
 * The approval is a staged card in a staged chat. What each check staged
 * comes back out and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t107-";
const TASK_ID = `${PREFIX}task`;
const LOG_TEXT = "smoke t107: llama server is listening";
const PROBE_DIR = "/smoke-t107-probe";
const AT = "2030-01-01T09:00:00Z";
const show = (s: unknown) => JSON.stringify(s);
const q = (v: unknown) => JSON.stringify(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* A renderer error is a failed check, never a thrown one (see t09). */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return (await js<T & Failed>(code)) ?? ({ err: "the renderer answered nothing" } as T & Failed);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

/** What this check needs from the agent and main, on the window's own IPC. */
class StandIn {
  readonly created: string[] = [];
  readonly logDirs: Array<string | null> = [];
  readonly memReads: string[] = [];
  private readonly create: Handler = (_e, input) => {
    const p = (input ?? {}) as { kind?: unknown; expression?: unknown; message?: unknown };
    this.created.push(`${String(p.kind)} ${String(p.expression)} ${String(p.message)}`);
    return { ok: true, id: TASK_ID };
  };
  private readonly log: Handler = (_e, dataDir) => {
    const dir = typeof dataDir === "string" ? dataDir : null;
    this.logDirs.push(dir);
    if (dir === PROBE_DIR) return { ok: true, path: null, size: null, truncated: false, text: "", lastReadAt: Date.now(), smokeT107: true };
    return { ok: true, path: `${dir ?? "/managed"}/llama-server.log`, size: LOG_TEXT.length, truncated: false, text: LOG_TEXT + "\n", lastReadAt: Date.now() };
  };
  private readonly memory: Handler = (_e, payload) => {
    this.memReads.push(String(((payload ?? {}) as { name?: unknown }).name));
    return { ok: true, rows: [], via: "node:sqlite" };
  };

  private channels(): Array<[string, Handler]> {
    return [["cli:taskCreate", this.create], ["app:llamaLogTail", this.log], ["app:memoryQuery", this.memory]];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }
}

export async function checks107(js: Js, check: Check): Promise<void> {
  managedLogPath(check);
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  try {
    agent.install(wins);
    const probe = await js<{ smokeT107?: boolean } | null>(`BR.llamaLogTail(${q(PROBE_DIR)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.smokeT107 !== true) {
      check("T107: a stand-in on the window's IPC answers the log read first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    await oneShotNote(js, check, agent);
    await logFolder(js, check, agent);
    await memoryPoll(js, check, agent);
  } finally {
    agent.uninstall(wins);
  }
  await jumpToRequest(js, check);
}

/* ATO-195, main's side: with no folder named, the managed one the agent
   resolves — localModels.managed.dataDirOverride, else <state dir>/models. */
function managedLogPath(check: Check): void {
  let override: string | null = null;
  try {
    const cfg = JSON.parse(readFileSync(join(DESKTOP_STATE_DIR, "config.json"), "utf8")) as { localModels?: { managed?: { dataDirOverride?: unknown } } };
    const o = cfg.localModels?.managed?.dataDirOverride;
    override = typeof o === "string" ? o : null;
  } catch {
    // no config yet: the default folder
  }
  const want = join(managedDataDir(override), "llama-server.log");
  const got = llamaLogTail(null);
  check(
    "T107 (ATO-195): with no folder named, main reads llama-server.log in the managed folder the agent uses",
    got.ok && (got.path === null ? !existsSync(want) : got.path === want),
    show({ want, path: got.path, ok: got.ok, error: got.error }),
  );
}

/* ATO-193. */
async function oneShotNote(js: Js, check: Check, agent: StandIn): Promise<void> {
  const mark = agent.created.length;
  const r = await safe<{ previewOk: boolean; firings: number[]; html: string; submit: { ok: boolean; id?: string; error?: string }; note: string | null; toast: string; caveatFn: boolean }>(js, `(async () => {
    const keep = {mode: TK.mode, form: TK.form, msg: TK.msg, note: TK.note, toasts: S.toasts.slice(), id: S.toastId};
    try {
      TK.mode = 'create'; TK.form = tkNewForm();
      Object.assign(TK.form, {kind: 'at', atIsoOrMs: ${q(AT)}, message: 'smoke t107: a one-shot that is never created'});
      const res = await tkPreview();
      const f = TK.form;
      const html = f ? tkPreviewHTML(f) : '';
      const firings = f ? f.preview.nextFirings.slice() : [];
      const submit = await tkSubmit();
      const mine = S.toasts.filter((t) => t.id > keep.id);
      return {previewOk: !!(res && res.ok !== false && f && f.preview.ok), firings, html, submit, note: TK.note,
        toast: mine.map((t) => t.t + ': ' + t.s).join(' | '), caveatFn: typeof tkAtNote !== 'undefined'};
    } finally {
      TK.mode = keep.mode; TK.form = keep.form; TK.msg = keep.msg; TK.note = keep.note;
      S.toasts = keep.toasts; renderToasts(); render();
    }
  })()`);
  const sent = agent.created.slice(mark);
  const caveat = /0\.5\.4|next tick|stores no next-run|set-atnote/;
  check(
    "T107 (ATO-193): a one-shot's preview shows its time and no 0.5.4 next-tick caveat",
    !r.err && r.previewOk && show(r.firings) === show([Date.parse(AT)]) && !caveat.test(r.html) && !r.caveatFn,
    r.err ?? show({ previewOk: r.previewOk, firings: r.firings, html: r.html.replace(/<[^>]+>/g, " ").slice(0, 300) }),
  );
  check(
    "T107 (ATO-193): creating it says the TUI's success line alone — no caveat under it or in the toast",
    !r.err && r.submit.ok && r.submit.id === TASK_ID && sent.length === 1 && sent[0]!.startsWith(`at ${Date.parse(AT)} `)
      && r.note === null && r.toast === `Task scheduled: task ${TASK_ID} scheduled (at)`,
    r.err ?? show({ submit: r.submit, sent, note: r.note, toast: r.toast }),
  );
}

/* ATO-195, the viewer's side. */
async function logFolder(js: Js, check: Check, agent: StandIn): Promise<void> {
  const mark = agent.logDirs.length;
  const r = await safe<{ pending: { text: string; external: boolean; error: string | null }; named: { text: string }; external: { external: boolean } }>(js, `(async () => {
    const keep = {status: LLMP.status, statusErr: LLMP.statusErr, statusBusy: LLMP.statusBusy, open: DIAG.logOpen, log: DIAG.log, asked: DIAG.statusAsked};
    const pick = () => ({text: DIAG.log ? DIAG.log.text : '', external: !!(DIAG.log && DIAG.log.external), error: DIAG.log ? DIAG.log.error || null : 'no read'});
    try {
      diagLogStop();
      // A models status already on its way: llmRefreshStatus returns at once and nothing names the folder.
      Object.assign(LLMP, {status: null, statusErr: null, statusBusy: true});
      Object.assign(DIAG, {logOpen: true, log: null, statusAsked: false});
      await diagLogRefresh(true);
      const pending = pick();
      Object.assign(LLMP, {status: {mode: 'managed', dataDir: '/smoke-t107/models'}, statusBusy: false});
      await diagLogRefresh();
      const named = pick();
      Object.assign(LLMP, {status: {mode: 'external', dataDir: null}});
      await diagLogRefresh();
      return {pending, named, external: pick()};
    } finally {
      Object.assign(LLMP, {status: keep.status, statusErr: keep.statusErr, statusBusy: keep.statusBusy});
      Object.assign(DIAG, {logOpen: keep.open, log: keep.log, statusAsked: keep.asked});
      diagLogStop(); diagRepaint();
    }
  })()`);
  const dirs = agent.logDirs.slice(mark);
  check(
    "T107 (ATO-195): with models status still on its way, the log is read from main's managed folder, not left at \"No log yet\"",
    !r.err && dirs[0] === null && r.pending.text.includes(LOG_TEXT) && !r.pending.external && r.pending.error === null,
    r.err ?? show({ dirs, pending: r.pending }),
  );
  check(
    "T107 (ATO-195): a folder models status names is still the one read; an external route reads none",
    !r.err && dirs[1] === "/smoke-t107/models" && r.named.text.includes(LOG_TEXT) && dirs.length === 2 && r.external.external,
    r.err ?? show({ dirs, named: r.named, external: r.external }),
  );
}

/* ATO-196. A read is a memRefresh started (MEM.seq); the stand-in answers each. */
async function memoryPoll(js: Js, check: Check, agent: StandIn): Promise<void> {
  const mark = agent.memReads.length;
  const r = await safe<{ visible: boolean; entered: number; inFlight: number; landed: number; focus: number; paused: number; shown: number; ticked: number; tickMoved: boolean }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const keep = {settings: S.settings, pane: S.settingsPane, overlay: S.overlay, rows: MEM.rows, at: MEM.lastRefreshedAt, auto: MEM.auto, mode: MEM.mode,
      channel: MEM.channel, err: MEM.lastError, hint: MEM.channelHint, cursor: MEM.cursor, search: MEM.search};
    const reads = () => MEM.seq;
    try {
      Object.assign(MEM, {auto: true, mode: 'list', channel: 'profile', search: ''});
      S.overlay = null; S.settings = 1; S.settingsPane = 'memory'; render(); await tick(200);
      const visible = memoryVisible();
      // Shown again with rows already read: it reads again at once.
      let n = reads(); MEM.lastRefreshedAt = Date.now() - 60000; memoryTabEntered(); await tick(150);
      const entered = reads() - n;
      // A read on its way lands first: a tick starts no other.
      n = reads(); MEM.loading = true; MEM.loadingAt = Date.now(); memAutoRefresh(); await tick(100);
      const inFlight = reads() - n;
      n = reads(); MEM.loading = false; memAutoRefresh(); await tick(150);
      const landed = reads() - n;
      // The window back to the front reads again; paused, it does not.
      n = reads(); window.dispatchEvent(new Event('focus')); await tick(150);
      const focus = reads() - n;
      n = reads(); MEM.auto = false; window.dispatchEvent(new Event('focus')); await tick(150);
      const paused = reads() - n; MEM.auto = true;
      n = reads(); document.dispatchEvent(new Event('visibilitychange')); await tick(150);
      const shown = document.hidden ? 1 : reads() - n;
      // And the 5 s poll itself: a read, and the time it landed (a little slack for a busy machine).
      n = reads(); const before = MEM.lastRefreshedAt;
      for (const until = Date.now() + 7000; Date.now() < until && !(reads() > n && MEM.lastRefreshedAt !== before);) await tick(200);
      return {visible, entered, inFlight, landed, focus, paused, shown, ticked: reads() - n, tickMoved: MEM.lastRefreshedAt !== before};
    } finally {
      MEM.seq++; MEM.loading = false;
      Object.assign(MEM, {rows: keep.rows, lastRefreshedAt: keep.at, auto: keep.auto, mode: keep.mode, channel: keep.channel, lastError: keep.err,
        channelHint: keep.hint, cursor: keep.cursor, search: keep.search});
      S.settings = keep.settings; S.settingsPane = keep.pane; S.overlay = keep.overlay;
      render();
    }
  })()`);
  const answered = agent.memReads.length - mark;
  check(
    "T107 (ATO-196): Memory reads again when shown again, and lets a read on its way land before the next",
    !r.err && r.visible && r.entered >= 1 && r.inFlight === 0 && r.landed >= 1 && answered >= 1,
    r.err ?? show({ ...r, answered }),
  );
  check(
    "T107 (ATO-196): the window back to the front reads Memory again (not while auto-refresh is paused), and the 5 s poll reads and moves the time",
    !r.err && r.focus >= 1 && r.paused === 0 && r.shown >= 1 && r.ticked >= 1 && r.tickMoved,
    r.err ?? show(r),
  );
}

/* ATO-187. */
async function jumpToRequest(js: Js, check: Check): Promise<void> {
  const r = await safe<{ skipped?: boolean; atEnd: { words: boolean; jump: boolean; card: boolean }; onCard: { words: boolean; jump: boolean }; back: { words: boolean; jump: boolean }; fits: { words: boolean; jump: boolean } }>(js, `(async () => {
    if (S.turnId || S.streamId || S.busy || S.pending || RUNNING.size > 0) return {skipped: true};
    // Two frames, or a timer where a hidden window draws none (as t13 waits).
    const frame = () => new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; setTimeout(res, 0); } };
      requestAnimationFrame(() => requestAnimationFrame(fin));
      setTimeout(fin, 300);
    });
    // A scroll the code makes, and the scroll event a person's would send (a hidden window may send none).
    const scrollTo = (top) => { const sc = document.getElementById('scroller'); sc.scrollTop = top; sc.dispatchEvent(new Event('scroll')); };
    const keep = {log: S.log, pending: S.pending, sessionId: S.sessionId, agentSession: S.agentSession, room: S.room, stick: S.stick,
      settings: S.settings, overlay: S.overlay, draft: S.draft};
    const look = () => {
      const strip = [...document.querySelectorAll('.statusstrip.gated')].find((n) => /Waiting for your approval/.test(n.textContent || ''));
      const jump = strip ? strip.querySelector('.ss-jump') : null;
      return {words: !!strip, jump: !!jump && !jump.hidden && jump.offsetParent !== null, card: !!document.getElementById('apprcard')};
    };
    try {
      const card = {id: nid(), k: 'approval', approvalId: ${q(`${PREFIX}approval`)}, tool: 'os.shell.run', cat: 'shell', kind: 'shell',
        reason: 'smoke t107', preview: 'df -h /', sessionId: ${q(`${PREFIX}chat`)}, at: 'now'};
      const filler = [];
      for (let i = 0; i < 40; i++) filler.push({id: nid(), k: i % 2 ? 'assistant' : 'user', text: 'smoke t107: a row under the card ' + i});
      S.settings = null; S.overlay = null; S.room = 'chat';
      S.sessionId = ${q(`${PREFIX}chat`)}; S.agentSession = ${q(`${PREFIX}chat`)}; S.draft = '';
      S.log = [{id: nid(), k: 'user', text: 'smoke t107: check free disk space'}, card].concat(filler);
      S.pending = card; S.stick = true;
      render(); await frame();
      const atEnd = look();
      const sc = document.getElementById('scroller');
      const c = document.getElementById('apprcard');
      scrollTo(sc.scrollTop + c.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16); await frame();
      const onCard = look();
      scrollTo(sc.scrollHeight); await frame();
      const back = look();
      // A chat short enough to show the card whole: no Jump from the first paint.
      S.log = [{id: nid(), k: 'user', text: 'smoke t107: check free disk space'}, card];
      render(); await frame();
      return {atEnd, onCard, back, fits: look()};
    } finally {
      S.log = keep.log; S.pending = keep.pending; S.sessionId = keep.sessionId; S.agentSession = keep.agentSession; S.room = keep.room;
      S.stick = keep.stick; S.settings = keep.settings; S.overlay = keep.overlay; S.draft = keep.draft;
      const seen = Object.keys(PREFS.seen).filter((k) => k.indexOf(${q(PREFIX)}) === 0);
      seen.forEach((k) => { delete PREFS.seen[k]; });
      if (seen.length) savePrefs();
      render();
    }
  })()`);
  if (r.skipped) { check("T107 ATO-187: the probe ran (the window was idle)", false, "a turn or an approval was in the way"); return; }
  check(
    "T107 (ATO-187): scrolled away from the card, the strip says Waiting for your approval and offers Jump to request",
    !r.err && r.atEnd.card && r.atEnd.words && r.atEnd.jump && r.back.words && r.back.jump,
    r.err ?? show({ atEnd: r.atEnd, back: r.back }),
  );
  check(
    "T107 (ATO-187): with the card in view the words stay and Jump to request is gone",
    !r.err && r.onCard.words && !r.onCard.jump && r.fits.words && !r.fits.jump,
    r.err ?? show({ onCard: r.onCard, fits: r.fits }),
  );
}
