import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Release-fix checks for the chat items of the 01.10 review (Д13–Д24 and
 * Д29), smoke id 46 (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=46`.
 *
 *   Д13 The start screen of an empty chat stands in the middle of a large
 *       window, in a column no wider than the transcript's.
 *   Д14 Its line names the working folder as "Working in ~/…", not by the
 *       folder's bare name ("macbook" for the home folder).
 *   Д15 No "New chat" title in the toolbar for a chat not yet named.
 *   Д16 The reasoning line says "Reasoning", with no step count.
 *   Д17 Copy and retry stand 6–8 px clear of the message they belong to.
 *   Д18 No end mark (the small glyph) under a finished reply. (ATO-168 later
 *       gave the LAST reply a dot, Valera's call, as `.enddot` — `.endmark`
 *       stays absent, and smoke 56 owns the dot.)
 *   Д19 A short conversation starts at the top (Nadya, 06.10: it used to sit
 *       on the composer; smoke 105 has the why), a long one still scrolls
 *       from its first line, and a bubble never runs past the column. The
 *       download card does not cover a short chat's end: a one-turn chat
 *       ending on an approval keeps its buttons within reach above the card,
 *       and folding or opening the card moves nothing.
 *   Д20 The composer's running line is 1px and slower.
 *   Д21 Where it runs: a row with nothing to run on carries Add provider and
 *       leads to Settings › Models; no red refusal grows the menu.
 *   Д22 Scrollbars in the theme's ink; the side panel starts closed on every
 *       launch, whatever an older build stored.
 *   Д23 A path in a reply opens the file — only one that exists inside the
 *       home folder, through main's own check, and never by running it.
 *   Д24 A microphone that works looks live; one that cannot says why.
 *   Д29 The working folder reads the same in the chat, Settings › General and
 *       Diagnostics, from one helper.
 *
 * Nothing reaches the agent and no file outside a throwaway folder is
 * written: transcripts are staged rows in a new chat, the Where it runs rows
 * are drawn from a stand-in config in the window's copy only, the voice probe
 * is stood in and asked again at the end, and the files a reply names live in
 * a temporary folder inside the home folder (the smoke's own home under
 * smoke.sh) that is removed. No file is opened: the chip's click goes through
 * the opener's dry-run seam, and main's open is asked only about paths it
 * refuses.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const q = (v: unknown) => JSON.stringify(v);

/** One section's checks; a throw in it is its own FAIL and the next section still runs. */
async function section(name: string, check: Check, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    check(`T46 ${name}: its checks ran to the end`, false, err instanceof Error ? err.message : String(err));
  }
}

export async function checks46(js: Js, check: Check): Promise<void> {
  await section("start screen", check, () => startScreen(js, check));
  await section("working folder", check, () => workingFolder(js, check));
  await section("transcript", check, () => transcript(js, check));
  await section("download card", check, () => downloadCard(js, check));
  await section("composer", check, () => composer(js, check));
  await section("where it runs", check, () => whereItRuns(js, check));
  await section("panels", check, () => panels(js, check));
  await section("reply paths", check, () => replyPaths(js, check));
  await js<unknown>("window.__newSession()").catch(() => undefined);
}

/* Д13, Д14, Д15 — the empty chat as a new chat opens it. */
async function startScreen(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(async () => {
    await window.__newSession();
    await new Promise((res) => setTimeout(res, 300));
    const sc = document.querySelector('#scroller');
    const ec = sc && sc.querySelector('.emptychat');
    if (!ec) return {err: 'no start screen'};
    const plate = ec.querySelector('.emptyplate'), ghost = ec.querySelector('.ghost') || plate;
    const s = sc.getBoundingClientRect(), e = ec.getBoundingClientRect();
    const top = plate.getBoundingClientRect().top, bottom = ghost.getBoundingClientRect().bottom;
    const meta = ec.querySelector('.emptymeta .em-wd');
    const wd = workingDir();
    const tb = document.querySelector('#toolbar .tb-title');
    return {scHeight: Math.round(s.height), scWidth: Math.round(s.width), width: Math.round(e.width),
      offCentre: Math.round((top + bottom) / 2 - (s.top + s.bottom) / 2), clearOfComposer: Math.round(s.bottom - bottom),
      meta: meta ? meta.textContent : null, metaTitle: meta ? meta.getAttribute('title') : null,
      wd, label: workingDirLabel(wd), title: tb ? tb.textContent : null, roomTitle: roomTitle()};
  })()`);
  check(
    "T46 Д13: the empty chat's greeting stands in the middle of the transcript area, not on the composer",
    !r.err && Math.abs(Number(r.offCentre)) <= 40 && Number(r.clearOfComposer) > 60,
    q(r),
  );
  check("T46 Д13: its column is no wider than the transcript's (720px)", !r.err && Number(r.width) <= 720, q({ width: r.width, scroller: r.scWidth }));
  check(
    "T46 Д14: the line under the greeting says Working in and the folder's path, the full path in its tooltip",
    !!r.wd && r.meta === `Working in ${String(r.label)}` && r.metaTitle === r.wd,
    q({ meta: r.meta, title: r.metaTitle, wd: r.wd }),
  );
  check("T46 Д15: a chat not yet named has no title in the toolbar", r.title === null && r.roomTitle === "", q({ title: r.title, roomTitle: r.roomTitle }));
}

/* Д29 — one helper, one way of writing the folder, three places. */
async function workingFolder(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const keep = {settings: S.settings, pane: S.settingsPane};
    const wd = workingDir(), home = homeDir();
    try {
      window.__settingsOpen('general'); await tick(250);
      const g = document.querySelector('#settings .set-general .set-path');
      const general = g ? g.textContent : null;
      window.__settingsOpen('diagnostics'); await tick(250);
      const row = [...document.querySelectorAll('#settings .set-diagrow')].find((n) => ((n.querySelector('.t') || {}).textContent || '') === 'Working folder');
      const diag = row ? ((row.querySelector('.set-diagv') || {}).textContent || null) : null;
      // On this platform's separators (backslashes on Windows).
      const sep = IS_WIN ? '\\\\' : '/';
      return {wd, home, label: workingDirLabel(wd), general, diag,
        homeLabel: home ? workingDirLabel(home) : null, inside: home ? workingDirLabel(home + sep + 'Projects' + sep + 'app' + sep) : null,
        insideWant: '~' + sep + 'Projects' + sep + 'app', outside: workingDirLabel('/Volumes/Work/app')};
    } finally {
      window.__settingsClose();
      if (keep.settings) { S.settings = keep.settings; S.settingsPane = keep.pane; render(); }
    }
  })()`);
  check(
    "T46 Д29: Settings › General and Diagnostics write the working folder exactly as the chat does",
    !!r.wd && r.general === r.label && r.diag === r.label,
    q(r),
  );
  check(
    "T46 Д29: the home folder is written out whole, a folder inside it as ~/…, one outside it whole",
    (r.home ? r.homeLabel === r.home && r.inside === r.insideWant : true) && r.outside === "/Volumes/Work/app",
    q({ home: r.home, homeLabel: r.homeLabel, inside: r.inside, insideWant: r.insideWant, outside: r.outside }),
  );
}

/* Д16, Д17, Д18, Д19 — staged rows in a new chat. */
async function transcript(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    await window.__newSession(); await tick(200);
    S.log.push({id: nid(), k: 'user', text: 'smoke t46: a short question'});
    S.log.push({id: nid(), k: 'reason', text: 'smoke t46: thinking it through', steps: 3, open: false});
    S.log.push({id: nid(), k: 'assistant', text: 'smoke t46: a short answer'});
    render(); await tick(80);
    const sc = document.querySelector('#scroller'), col = sc && sc.querySelector('.col720');
    if (!col) return {err: 'no transcript column'};
    const s = sc.getBoundingClientRect(), c = col.getBoundingClientRect();
    const disc = sc.querySelector('.disc');
    const gap = (sel) => {
      const t = [...sc.querySelectorAll(sel)].pop();
      const body = t && (t.querySelector('.bubble') || t.querySelector('.prose'));
      const b = t && t.querySelector('.msgacts button');
      return body && b ? Math.round(b.getBoundingClientRect().top - body.getBoundingClientRect().bottom) : null;
    };
    const short = {reasoning: disc ? disc.textContent.trim() : null,
      userGap: gap('.turn.usr'), replyGap: gap('.turn:not(.usr):not(.tk-step):not(.tk-working)'),
      marks: sc.querySelectorAll('.endmark').length,
      scrolls: sc.scrollHeight > sc.clientHeight, onComposer: Math.round(s.bottom - c.bottom), above: Math.round(c.top - s.top)};
    // A long one: it scrolls, and its first line is still reachable at the top.
    for (let i = 0; i < 40; i++) S.log.push({id: nid(), k: 'assistant', text: 'smoke t46 filler ' + i + ' ' + 'lorem ipsum dolor '.repeat(14)});
    render(); await tick(80);
    const sc2 = document.querySelector('#scroller'), col2 = sc2.querySelector('.col720');
    sc2.scrollTop = 0; await tick(30);
    const long = {scrolls: sc2.scrollHeight > sc2.clientHeight,
      colTop: Math.round(col2.getBoundingClientRect().top - sc2.getBoundingClientRect().top)};
    // A message no line can break, with the side panel narrowing the column.
    const keepInsp = S.inspector;
    S.inspector = true;
    S.log.push({id: nid(), k: 'user', text: 'https://example.com/' + 'a'.repeat(300) + ' /Users/someone/' + 'b'.repeat(240) + '.docx '
      + 'c'.repeat(500) + ' ' + '\\u6f22\\u5b57'.repeat(120)});
    render(); await tick(80);
    const sc3 = document.querySelector('#scroller'), col3 = sc3.querySelector('.col720'), cs = getComputedStyle(col3);
    const b = [...sc3.querySelectorAll('.turn.usr .bubble')].pop();
    const wide = {sw: sc3.scrollWidth, cw: sc3.clientWidth, bubbleRight: Math.round(b.getBoundingClientRect().right),
      colRight: Math.round(col3.getBoundingClientRect().right - parseFloat(cs.paddingRight)), inspector: !document.querySelector('#inspector').classList.contains('hide')};
    S.inspector = keepInsp;
    await window.__newSession();
    return {short, long, wide};
  })()`);
  const s = (r.short ?? {}) as Record<string, unknown>;
  const l = (r.long ?? {}) as Record<string, unknown>;
  const w = (r.wide ?? {}) as Record<string, unknown>;
  check("T46 Д16: the reasoning line reads Reasoning, with no step count", s.reasoning === "Reasoning", q(s.reasoning ?? r.err));
  const inRange = (v: unknown) => typeof v === "number" && v >= 6 && v <= 8;
  check(
    "T46 Д17: copy and retry stand 6–8 px below the bubble and below the reply",
    inRange(s.userGap) && inRange(s.replyGap),
    q({ user: s.userGap, reply: s.replyGap }),
  );
  check("T46 Д18: no end mark under a finished reply", s.marks === 0, q({ marks: s.marks }));
  check(
    "T46 Д19: a short conversation starts at the top, with the free space below it (06.10)",
    s.scrolls === false && Math.abs(Number(s.above)) <= 1 && Number(s.onComposer) > 100,
    q({ onComposer: s.onComposer, above: s.above, scrolls: s.scrolls }),
  );
  check("T46 Д19: a long one scrolls, and its first line is there at the top", l.scrolls === true && Math.abs(Number(l.colTop)) <= 1, q(l));
  check(
    "T46 Д19: a message with nothing to break on stays inside the column, the side panel open",
    w.sw === w.cw && Number(w.bubbleRight) <= Number(w.colRight) + 1,
    q(w),
  );
}

/* Д19, its review — the download card over a one-turn chat ending on an
   approval, as T18-F6 stages a long one. (It was staged when the transcript
   sat on the composer, right where the card stands; since 06.10 it starts at
   the top, and the buttons have to stay within reach all the same.) Staged rows and a seeded download (no
   download runs); both are taken back out. */
async function downloadCard(js: Js, check: Check): Promise<void> {
  type Box = { top: number; bottom: number; left: number; right: number } | null;
  type Shot = { appr: Box; card: Box; first: Box; abort: boolean; allow: boolean; deny: boolean };
  const r = await js<{ skipped?: string; plain?: Shot; open?: Shot; folded?: Shot; reopened?: Shot; gone?: Shot }>(`(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    if (DL.job || DL.queue.length) return {skipped: 'a download is running'};
    const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
      return {top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right)}; };
    // A press at the button's centre reaches the button, not the card over it.
    const reach = (sel) => { const appr = document.getElementById('apprcard'); const n = appr && appr.querySelector(sel);
      const b = n && n.getBoundingClientRect(); const at = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
      return !!(at && (at === n || n.contains(at))); };
    const shot = () => ({appr: box(document.getElementById('apprcard')), card: box(document.querySelector('#dlcard:not([hidden]) > *')),
      first: box(document.querySelector('#scroller .turn')), abort: reach('.apprabort'), allow: reach('[data-appr="y"]'), deny: reach('.apprdeny')});
    const keep = {log: S.log, pending: S.pending, focused: S.apprFocused, stick: S.stick, room: S.room, toasts: S.toasts.slice()};
    try {
      window.__dlClear(); S.toasts = []; renderToasts(); S.room = 'chat';
      const req = {id: nid(), k: 'approval', approvalId: 'smoke-t46-appr', tool: 'os.fs.write', cat: 'fs_write_workspace',
        kind: CATEGORY_LABEL.fs_write_workspace, lvl: 2, reason: 'smoke t46 fixture', preview: '(no preview)', shape: '',
        affectsBase: 'notes.md', affectsDir: '', sessionGrants: false, sessionId: S.agentSession};
      S.log = [{id: nid(), k: 'user', text: 'smoke t46: add a line to the notes file'}, req];
      S.pending = req; S.apprFocused = true; S.stick = true;
      render(); await tick(150);
      const plain = shot();
      window.__dlSeed([{kind: 'runtime', id: 'llama.cpp'}, {kind: 'weights', id: 'qwen-3.5-9b'}]);
      window.__dlFeed({id: 'llama.cpp', kind: 'runtime', percent: 40, transferredBytes: 30000000, totalBytes: 75000000});
      await tick(300);
      const open = shot();
      const fold = document.querySelector('#dlcard .dlc-fold'); if (fold) fold.click();
      await tick(150);
      const folded = shot();
      const badge = document.querySelector('#dlcard .dlc-badge'); if (badge) badge.click();
      await tick(150);
      const reopened = shot();
      window.__dlClear(); await tick(200);
      const gone = shot();
      return {plain, open, folded, reopened, gone};
    } finally {
      window.__dlClear();
      S.log = keep.log; S.pending = keep.pending; S.apprFocused = keep.focused; S.stick = keep.stick; S.room = keep.room; S.toasts = keep.toasts;
      render();
    }
  })()`);
  if (r.skipped) {
    check("T46 Д19: the download card over a one-turn chat (not staged)", true, r.skipped);
    return;
  }
  const { plain, open, folded, reopened, gone } = r;
  const within = (s: Shot | undefined) => !!s && !!s.appr && !!s.card && s.appr.bottom <= s.card.top && s.abort && s.allow && s.deny;
  check(
    "T46 Д19: with the download card open, a one-turn chat ending on an approval sits above it — Abort run, Allow once and Deny all within reach",
    !!plain && plain.abort && within(open),
    q({ plain, open }),
  );
  check(
    "T46 Д19: folding and opening the card move nothing, and the chat settles back when the card goes",
    !!open && !!folded && !!reopened && !!gone && !!plain && !!folded.first && !!open.first
      && folded.first.top === open.first.top && reopened.first?.top === open.first.top
      && gone.first?.top === plain.first?.top && folded.abort && folded.allow && folded.deny && within(reopened),
    q({ open: open?.first, folded: folded?.first, reopened: reopened?.first, gone: gone?.first, plain: plain?.first }),
  );
}

/* Д20 and Д24 — the composer's running line and its microphone. */
async function composer(js: Js, check: Check): Promise<void> {
  const loader = await js<Record<string, unknown>>(`(() => {
    const c = document.querySelector('#composer');
    if (!c) return {err: 'no composer'};
    const l = document.createElement('span'); l.className = 'cloader';
    l.innerHTML = '<span class="cl-glow"></span><span class="cl-rim"></span>';
    c.appendChild(l);
    try {
      const rim = l.querySelector('.cl-rim');
      return {rim: getComputedStyle(rim).paddingTop, lap: getComputedStyle(c).getPropertyValue('--cl-lap').trim(),
        running: getComputedStyle(rim, '::before').animationDuration};
    } finally { l.remove(); }
  })()`);
  check("T46 Д20: the composer's running line is 1px and laps in 7 s (it was 2px and 4.2 s)", loader.rim === "1px" && loader.lap === "7s", q(loader));

  const mic = await js<Record<string, unknown>>(`(async () => {
    if (!document.querySelector('.composer .field .micbtn')) return {skipped: 'no microphone on this platform'};
    // Found by its title after the press, so an older toast expiring meanwhile cannot hide it.
    const OFF = 'Voice input is off';
    S.toasts = S.toasts.filter((t) => t.t !== OFF);
    try {
      window.__voiceProbeSet({available: true});
      const on = document.querySelector('.composer .field .micbtn');
      const live = {color: getComputedStyle(on).color, ink: getComputedStyle(document.body).color,
        aria: on.getAttribute('aria-disabled'), disabled: on.disabled};
      window.__voiceProbeSet({available: false, reason: 'voice-helper-missing'});
      const off = document.querySelector('.composer .field .micbtn');
      const offView = {aria: off.getAttribute('aria-disabled'), title: off.getAttribute('title'), hook: window.__voiceMic().disabled};
      off.click();   // a press with no mousedown before it: the keyboard's way in
      await new Promise((res) => setTimeout(res, 60));
      return {live, off: offView, said: S.toasts.filter((t) => t.t === OFF).map((t) => t.t + ' / ' + t.s),
        reason: VOICE_REASONS['voice-helper-missing'], state: VOICE.state};
    } finally {
      await window.__voiceReprobe();
    }
  })()`);
  if (mic.skipped) {
    check("T46 Д24: the microphone (not drawn on this platform)", true, String(mic.skipped));
    return;
  }
  const live = (mic.live ?? {}) as Record<string, unknown>;
  const off = (mic.off ?? {}) as Record<string, unknown>;
  check(
    "T46 Д24: a microphone that works is drawn in the full ink, not the disabled grey",
    live.color === live.ink && live.aria === null && live.disabled === false,
    q(live),
  );
  check(
    "T46 Д24: one that cannot work is marked off, says why in its tooltip, and says it again when pressed",
    off.aria === "true" && off.hook === true && off.title === mic.reason
      && Array.isArray(mic.said) && (mic.said as string[]).includes(`Voice input is off / ${String(mic.reason)}`)
      && mic.state !== "starting" && mic.state !== "recording",
    q(mic),
  );
}

/* Д21 — Where it runs, drawn from a stand-in config in the window's copy. */
async function whereItRuns(js: Js, check: Check): Promise<void> {
  const STAGE = `
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const stage = async () => {
      LIVE_CONFIG = {llm: {activeTextProvider: 'local-llama', providers: [{id: 'local-llama', kind: 'llama-server'}]}, localModels: {mode: 'managed'}};
      BSW.readyIds = []; BSW.readyLoaded = true; BSW.localLoaded = true;
      SEL.local = [{id: 'smoke-t46-model', downloaded: true, active: true}]; SWX.want = null;
      SEL.kind = 'backend'; SEL.open = true; SEL.err = null; SEL.addOpen = false; WIZ.phase = null;
      render(); await tick(60);
    };
    // ATO-254: wait for the menu to close and Settings to open, up to 3 s, rather than a fixed
    // 150 ms that a slow runner (windows-11-arm) did not always meet.
    const settled = async () => {
      for (let waited = 0; waited < 3000; waited += 50) {
        if (!document.querySelector('.selpop .modelrow[data-id="fusion"]') && S.settings) break;
        await tick(50);
      }
      await tick(50);
    };
    const after = () => ({err: document.querySelectorAll('.selerr').length + (SEL.err ? 1 : 0),
      backendShown: !!document.querySelector('.selpop .modelrow[data-id="fusion"]'),
      settings: S.settings ? settingsPaneId(S.settingsPane) : null, wiz: WIZ.phase || null, llmMode: LLMP.mode});
  `;
  const r = await js<Record<string, unknown>>(`(async () => {
    ${STAGE}
    const keep = {cfg: LIVE_CONFIG, ids: BSW.readyIds, rl: BSW.readyLoaded, ll: BSW.localLoaded, local: SEL.local, want: SWX.want,
      kind: SEL.kind, open: SEL.open, err: SEL.err, addOpen: SEL.addOpen, wiz: Object.assign({}, WIZ), settings: S.settings, pane: S.settingsPane,
      llm: {mode: LLMP.mode, sync: LLMP.syncModeToRoute, spent: LLMP.routeSyncSpent}, log: S.log.length};
    try {
      await stage();
      const rows = selRows().map((x) => ({id: x.id, detail: x.detail, add: !!x.addProvider}));
      const withButton = [...document.querySelectorAll('.selpop .modelrow')].filter((n) => n.querySelector('.seladd')).map((n) => n.dataset.id);
      const label = ((document.querySelector('.selpop .modelrow[data-id="cloud"] .seladd') || {}).textContent || '').trim();
      // The Cloud row's own button.
      const btn = document.querySelector('.selpop .modelrow[data-id="cloud"] .seladd');
      if (btn) btn.click();
      await settled();
      const viaButton = after();
      act('close'); window.__settingsClose(); await tick(50);
      // The blocked Fusion row itself — what used to raise the red line.
      await stage();
      const fz = document.querySelector('.selpop .modelrow[data-id="fusion"]');
      if (fz) fz.click();
      await settled();
      const viaRow = after();
      return {rows, withButton, label, viaButton, viaRow, logGrew: S.log.length - keep.log};
    } finally {
      WIZ.unfinishedId = null; act('close'); window.__settingsClose();
      LIVE_CONFIG = keep.cfg; BSW.readyIds = keep.ids; BSW.readyLoaded = keep.rl; BSW.localLoaded = keep.ll;
      SEL.local = keep.local; SWX.want = keep.want; SEL.kind = keep.kind; SEL.open = keep.open; SEL.err = keep.err; SEL.addOpen = keep.addOpen;
      Object.assign(WIZ, keep.wiz);
      LLMP.mode = keep.llm.mode; LLMP.syncModeToRoute = keep.llm.sync; LLMP.routeSyncSpent = keep.llm.spent;
      if (keep.settings) { S.settings = keep.settings; S.settingsPane = keep.pane; }
      render();
    }
  })()`);
  const rows = (r.rows ?? []) as Array<{ id: string; detail: string; add: boolean }>;
  const row = (id: string) => rows.find((x) => x.id === id);
  check(
    "T46 Д21: with no cloud provider, Cloud and Fusion carry Add provider and say what is missing — not a screen to go and find",
    row("cloud")?.add === true && row("fusion")?.add === true && row("local")?.add === false
      && row("cloud")?.detail === "no provider yet" && row("fusion")?.detail === "needs a second provider to orchestrate"
      && !rows.some((x) => /Settings ›/.test(x.detail ?? "") && x.id !== "custom")
      && q(r.withButton) === q(["cloud", "fusion"]) && r.label === "Add provider",
    q({ rows, withButton: r.withButton, label: r.label }),
  );
  const opened = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return o.err === 0 && o.backendShown === false && o.settings === "llm" && o.wiz === "pick_kind" && o.llmMode === "cloud";
  };
  check(
    "T46 Д21: Add provider opens Settings › Models on its cloud providers with the provider setup started",
    opened(r.viaButton),
    q(r.viaButton),
  );
  check(
    "T46 Д21: choosing the blocked Fusion row goes there too — no red refusal in the menu, no line in the chat",
    opened(r.viaRow) && r.logGrew === 0,
    q({ viaRow: r.viaRow, logGrew: r.logGrew }),
  );
}

/* Д22 — themed scrollbars, and the side panel closed at launch. */
async function panels(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const color = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).scrollbarColor : null; };
    const colors = {scroller: color('#scroller'), inspector: color('#inspector'), sidebar: color('#sidebar .sb-lists')};
    const keep = S.inspector;
    let atLaunch = null, stored = 'unread', open = null, afterToggles = 'unread';
    try {
      localStorage.setItem('atag.inspector', 'open');
      atLaunch = inspectorAtLaunch();
      stored = localStorage.getItem('atag.inspector');
      act('toggle:inspector'); open = S.inspector; act('toggle:inspector');
      afterToggles = localStorage.getItem('atag.inspector');
    } finally { S.inspector = keep; render(); }
    return {colors, keep, atLaunch, stored, open, afterToggles};
  })()`);
  const colors = (r.colors ?? {}) as Record<string, string | null>;
  check(
    "T46 Д22: the transcript, side panel and sidebar scrollbars take the theme's colours, not the system's white track",
    ["scroller", "inspector", "sidebar"].every((k) => typeof colors[k] === "string" && colors[k] !== "auto" && colors[k] !== ""),
    q(colors),
  );
  check(
    "T46 Д22: the side panel starts closed at launch whatever an older build stored, and opening it is not remembered",
    r.atLaunch === false && r.stored === null && r.open === !r.keep && r.afterToggles === null,
    q(r),
  );
}

/* Д23 — paths in a reply: real files in a throwaway folder inside the home folder. */
async function replyPaths(js: Js, check: Check): Promise<void> {
  const home = homedir();
  const dir = mkdtempSync(join(home, ".atomic-t46-"));
  const out = mkdtempSync(join(tmpdir(), "aa-t46-out-"));
  try {
    const rel = dir.slice(home.length + 1);
    writeFileSync(join(dir, "trump_news_30_sep_2026.docx"), "smoke t46\n");
    mkdirSync(join(dir, "Space Folder"));
    writeFileSync(join(dir, "Space Folder", "report final.pdf"), "smoke t46\n");
    writeFileSync(join(dir, "run.command"), "#!/bin/sh\necho smoke t46\n");
    writeFileSync(join(out, "outside.docx"), "smoke t46\n");
    const docx = `~/${rel}/trump_news_30_sep_2026.docx`;
    const spaced = `~/${rel}/Space Folder/report final.pdf`;
    const runs = `~/${rel}/run.command`;
    const missing = `~/${rel}/missing.docx`;
    const outside = join(out, "outside.docx");
    const real = {
      docx: realpathSync(join(dir, "trump_news_30_sep_2026.docx")),
      spaced: realpathSync(join(dir, "Space Folder", "report final.pdf")),
      runs: realpathSync(join(dir, "run.command")),
    };
    const text = [
      `Saved the news to ${docx} for you.`,
      `The report is in \`${spaced}\`.`,
      `Not there: ${missing}. Outside the home folder: ${outside}.`,
      "```",
      `cat ${docx}`,
      "```",
      `The script: ${runs}`,
    ].join("\n");

    const r = await js<Record<string, unknown>>(`(async () => {
      const tick = (ms) => new Promise((res) => setTimeout(res, ms));
      await window.__newSession(); await tick(150);
      S.log.push({id: nid(), k: 'user', text: 'smoke t46: where is it?'});
      S.log.push({id: nid(), k: 'assistant', text: ${q(text)}});
      render();
      const row = () => [...document.querySelectorAll('#scroller .turn')].pop();
      const before = row().querySelectorAll('.filechip').length;
      let chips = [];
      for (let i = 0; i < 80 && chips.length < 3; i++) { await tick(50); chips = [...row().querySelectorAll('.prose .filechip')]; }
      const prose = row().querySelector('.prose');
      return {before, chips: chips.map((c) => ({file: c.dataset.file, reply: c.dataset.reply || null, name: c.textContent})),
        fenced: (prose.querySelector('.mdpre') || {}).textContent || '', inFence: prose.querySelectorAll('.mdpre .filechip').length,
        text: prose.textContent};
    })()`);
    const chips = (r.chips ?? []) as Array<{ file: string; reply: string | null; name: string }>;
    check(
      "T46 Д23: a path in a reply is text until main has looked at it",
      r.before === 0,
      q({ before: r.before }),
    );
    check(
      "T46 Д23: the files that are there become chips — bare, in a code span with spaces, and a script — each naming its real path",
      q(chips.map((c) => c.file)) === q([real.docx, real.spaced, real.runs]) && chips.every((c) => c.reply === "1")
        && q(chips.map((c) => c.name)) === q(["trump_news_30_sep_2026.docx", "report final.pdf", "run.command"]),
      q(chips),
    );
    const said = String(r.text ?? "");
    check(
      "T46 Д23: a path that is not there, one outside the home folder, and one inside a code block stay text",
      said.includes(missing) && said.includes(outside) && String(r.fenced).includes(`cat ${docx}`) && r.inFence === 0,
      q({ fenced: r.fenced, inFence: r.inFence }),
    );

    // The click: through the reply opener (main's check), in dry run — nothing is opened.
    const click = await js<Record<string, unknown>>(`(() => {
      const chip = [...document.querySelectorAll('#scroller .prose .filechip')].find((c) => /trump_news/.test(c.dataset.file || ''));
      if (!chip) return {err: 'no chip'};
      const keep = openReplyPath; let used = 0;
      openReplyPath = (p) => { used++; return keep(p); };
      LAST_OPEN_PATH = null; OPEN_PATH_DRYRUN = true;
      try { chip.click(); } finally { OPEN_PATH_DRYRUN = false; openReplyPath = keep; }
      return {used, opened: LAST_OPEN_PATH};
    })()`);
    check("T46 Д23: clicking the chip opens its file through main's own check", click.used === 1 && click.opened === real.docx, q(click));

    // Main, asked directly: it refuses what is not offered, and would show — not run — the script.
    const main = await js<Record<string, unknown>>(`(async () => {
      const ask = await window.atomic.replyPaths([${q(runs)}, ${q(docx)}, 'https://example.com/a.docx', ${q(outside)}]);
      const outsideOpen = await window.atomic.openReplyPath(${q(outside)});
      const missingOpen = await window.atomic.openReplyPath(${q(missing)});
      return {verdicts: (ask && ask.files || []).map((f) => ({ok: f.ok, reveal: f.reveal, why: f.why || null})), outsideOpen, missingOpen};
    })()`);
    const verdicts = (main.verdicts ?? []) as Array<{ ok: boolean; reveal: boolean; why: string | null }>;
    const outsideOpen = (main.outsideOpen ?? {}) as Record<string, unknown>;
    const missingOpen = (main.missingOpen ?? {}) as Record<string, unknown>;
    check(
      "T46 Д23: main shows a script in Finder instead of running it, and never offers a URL or a file outside the home folder",
      verdicts.length === 4 && verdicts[0]!.ok && verdicts[0]!.reveal && verdicts[1]!.ok && !verdicts[1]!.reveal
        && !verdicts[2]!.ok && verdicts[2]!.why === "not-a-path" && !verdicts[3]!.ok && verdicts[3]!.why === "outside-home",
      q(verdicts),
    );
    check(
      "T46 Д23: main's open refuses a file outside the home folder and one that is not there",
      outsideOpen.ok === false && outsideOpen.why === "outside-home" && missingOpen.ok === false && missingOpen.why === "missing",
      q({ outsideOpen, missingOpen }),
    );
  } finally {
    await js<unknown>("window.__newSession()").catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}
