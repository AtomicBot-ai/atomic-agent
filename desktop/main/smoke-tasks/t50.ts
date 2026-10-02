import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import type { HubSkillRow } from "../agent-cli.js";
import {
  HUB_CACHE_FRESH_MS,
  HUB_CACHE_MAX_AGE_MS,
  hubCache,
  hubConfigKey,
  SkillsHubCache,
  type HubBrowseAnswer,
} from "../skills-hub-cache.js";
import { DESKTOP_STATE_DIR } from "../state-dir.js";

/**
 * Release-fix checks for Danya's Settings › Skills items, Д41–Д46 (see
 * main/release-fixes-smoke.ts). Run alone with `--smoke --smoke-task=50`.
 *
 *   Д41 — the installed list had a Version column. Gone; the detail keeps it.
 *   Д42 — Browse Skills Hub was a small tinted button, and a "Skills Hub"
 *         card under the list said it again. One big blue button now.
 *   Д43 — `18 shown · 18 enabled · 0 disabled` sat beside the filters. The
 *         filters are tabs with their counts: All 18 · Enabled 18 · Disabled 0.
 *   Д44 — `● auto / manual` read as a status and was a button, and `manual`
 *         cut the counts off. Gone; Refresh spins while a pressed refresh runs.
 *   Д45 — the hub took ~15 s on every opening and search, on two spinners at
 *         once. Main keeps its last answer on disk (skills-hub-cache.ts): the
 *         hub opens on it, fetches again only when it is stale or on Browse
 *         again, and shows one loader at a time — placeholder rows when there
 *         is nothing to show, else Browse again's own spinner. A skill page
 *         opens at once from its row; only its source waits for ClawHub.
 *   Д46 — the skill page: back, title and Install out of line, a `claw`
 *         badge, `owner x · ↓275k · v1`, and the raw SKILL.md on the page.
 *         Back is flush with the title, Install on the title's line, no
 *         badge, "482k downloads · by x · v4.0.2", the source under Show source.
 *
 * Nothing reaches the network or the agent's skills. The window's own IPC
 * (asked before ipcMain's; a probe proves it first) answers `atag skill list`
 * with three staged skills, and stands in for the hub's browse, its kept
 * answer and ClawHub's detail read, each held until the check lets it go.
 * Main's cache is driven directly on a file of its own, and one staged entry
 * in the app's cache is read back through the real IPC and dropped after.
 * The Skills pane's state, the config read, the window size and the IPCs are
 * all put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };
type Handler = (event: unknown, arg: unknown) => unknown;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (x: unknown) => JSON.stringify(x);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) await wait(20);
  return ok();
}

/* A renderer error is a failed check, never a thrown one (t09). */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return await js<T & Failed>(code);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

const PROBE = "smoke-t50-probe";
const STAGED = [
  { name: "smoke-t50-alpha", version: "1.0.0", source: "global", enabled: true, description: "A staged skill." },
  { name: "smoke-t50-beta", version: "2.3.4", source: "bundled", enabled: true, description: "Another staged skill." },
  { name: "smoke-t50-gamma", version: "0.1.0", source: "project", enabled: false, description: "A disabled staged skill." },
];
const HUB: HubSkillRow[] = [
  { identifier: "@pskoett/smoke-t50-improver", source: "clawhub", downloads: 482149, description: "Captures learnings and corrections." },
  { identifier: "@acme/smoke-t50-pdf", source: "clawhub", downloads: 942, description: "Reads and fills PDF files." },
  { identifier: "anthropics/skills/smoke-t50-docx", source: "github", downloads: null, description: "Edits Word documents." },
];
const SKILL_MD = "---\nname: smoke-t50-improver\ndescription: Captures learnings.\n---\n\n# Smoke T50\n\nThe whole published file.";
const DETAIL = {
  slug: "smoke-t50-improver", ownerHandle: "pskoett", displayName: "Smoke T50 Improver", summary: "Captures learnings and corrections.",
  version: "4.0.2", downloads: 482149, skillMd: SKILL_MD,
};
const SMOKE_IDS = HUB.map((r) => r.identifier);

/** The window's IPC for what the Skills pane asks, as this check needs it. */
class StandIn {
  listHeld = false;
  browseHeld = true;
  /** What `cli:skillBrowse` answers when not held. */
  browseAnswer: HubBrowseAnswer = { ok: true, rows: HUB, hubError: null };
  /** What `cli:skillBrowseCached` answers. */
  kept: unknown = { ok: false };
  detailHeld = true;
  readonly browses: string[] = [];
  readonly details: string[] = [];
  private readonly heldLists: Array<() => void> = [];
  private readonly heldBrowses: Array<(v: HubBrowseAnswer) => void> = [];
  private readonly heldDetails: Array<(v: unknown) => void> = [];

  private readonly list: Handler = () => {
    const answer = { ok: true, rows: STAGED.map((r) => ({ ...r })) };
    if (!this.listHeld) return answer;
    return new Promise((res) => { this.heldLists.push(() => res(answer)); });
  };

  private readonly browse: Handler = (_e, query) => {
    this.browses.push(typeof query === "string" ? query : "");
    if (!this.browseHeld) return { ...this.browseAnswer, savedAt: Date.now() };
    return new Promise((res) => { this.heldBrowses.push(res as (v: HubBrowseAnswer) => void); });
  };

  private readonly cached: Handler = (_e, query) => (query === PROBE ? { ok: false, smokeT50: true } : this.kept);

  private readonly detail: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { slug?: unknown };
    const slug = typeof p.slug === "string" ? p.slug : "";
    this.details.push(slug);
    const answer = slug === DETAIL.slug
      ? { ok: true, detail: DETAIL }
      : { ok: true, detail: { ...DETAIL, slug, displayName: `Late ${slug}`, ownerHandle: "acme", downloads: 942 } };
    if (!this.detailHeld) return answer;
    return new Promise((res) => { this.heldDetails.push(() => res(answer)); });
  };

  private channels(): Array<[string, Handler]> {
    return [["cli:skillList", this.list], ["cli:skillBrowse", this.browse], ["cli:skillBrowseCached", this.cached], ["app:clawhubSkillDetail", this.detail]];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }

  releaseLists(): void { this.listHeld = false; for (const go of this.heldLists.splice(0)) go(); }
  releaseBrowses(answer: HubBrowseAnswer): void { for (const go of this.heldBrowses.splice(0)) go({ ...answer, savedAt: Date.now() }); }
  releaseDetails(): void { for (const go of this.heldDetails.splice(0)) go(undefined); }
  releaseAll(): void {
    this.releaseLists();
    this.releaseBrowses({ ok: false, error: "smoke t50: let go" });
    this.releaseDetails();
  }
}

/** The app window the smoke drives (the renderer's index.html). */
function appWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\.html$/.test(w.webContents.getURL())) ?? null;
}

/* Page-side helpers every script below starts with. */
const PAGE = `const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => [...document.querySelectorAll(s)];
  const box = () => document.querySelector('#settings .setbody');
  const spins = () => q('#settings .setbody .tk-spin').map((s) => { const b = s.closest('[data-act]'); return b ? b.dataset.act : (s.parentElement ? s.parentElement.className : '?'); });
  const hubRows = () => q('#settings .setbody [data-hub-row]').map((r) => r.dataset.hubRow);`;

/* The pane's state before the check, and the config read the check stages when there is one (the ClawHub api
   base, so a card asks the stand-in at once rather than after an `atag config get`). */
const SAVE = `(() => {
  const skp = {};
  for (const k of Object.keys(SKP)) if (!['timer', 'cardCache', 'hubSeq', 'cardSeq'].includes(k)) skp[k] = SKP[k];
  const cfg = LIVE_CONFIG;
  const skills = (cfg && cfg.skills) || {};
  const staged = cfg ? Object.assign({}, cfg, {skills: Object.assign({}, skills, {clawhub: Object.assign({}, skills.clawhub || {}, {apiBase: 'https://clawhub.smoke-t50.invalid'})})}) : null;
  window.__t50 = {skp, cfg, staged};
  if (staged) LIVE_CONFIG = staged;
  return true;
})()`;
const RESTORE = `(() => {
  const s = window.__t50;
  window.__settingsClose();
  if (!s) return false;
  Object.assign(SKP, s.skp); SKP.hubSeq++; SKP.cardSeq++;
  for (const id of ${show(SMOKE_IDS)}) SKP.cardCache.delete(id);
  if (s.staged && LIVE_CONFIG === s.staged) LIVE_CONFIG = s.cfg;
  delete window.__t50;
  render();
  return true;
})()`;

export async function checks50(js: Js, check: Check): Promise<void> {
  try {
    await cacheModule(check);
    await cacheWiring(js, check);
  } catch (e) {
    check("T50: the cache checks ran to the end", false, message(e));
  }
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  let saved = false;
  try {
    agent.install(wins);
    const probe = await js<{ smokeT50?: boolean } | null>(`window.atomic.skillBrowseCached(${show(PROBE)})`).catch((e: unknown) => message(e));
    if (typeof probe !== "object" || probe?.smokeT50 !== true) {
      check("T50: a stand-in on the window's IPC answers the Skills pane first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    saved = await js<boolean>(SAVE);
    await list(js, check, agent);
    await narrow(js, check);
    await hub(js, check, agent);
    await page(js, check, agent);
  } catch (e) {
    check("T50: its checks ran to the end", false, message(e));
  } finally {
    /* Held answers are let go and the stand-ins come off before anything else is awaited (t24, t26). */
    agent.releaseAll();
    agent.uninstall(wins);
    if (saved) await safe<boolean>(js, RESTORE);
    // The real `atag skill list` rows back on the pane.
    await safe<void>(js, "(async () => { for (let i = 0; i < 100 && SK.busy; i++) await new Promise((r) => setTimeout(r, 50)); await refreshSkillList(); })()");
  }
}

/* Д45, main's side: the cache module on a file of its own, its clock in the check's hand. */
async function cacheModule(check: Check): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aa-t50-"));
  try {
    const file = join(dir, "skills-hub-cache.json");
    let now = 1_800_000_000_000;
    const cache = new SkillsHubCache(file, () => now);
    let runs = 0;
    const answer = (rows: HubSkillRow[], hubError: string | null = null) => async (): Promise<HubBrowseAnswer> => {
      runs++;
      await wait(30);
      return { ok: true, rows, hubError };
    };
    // Two asks for one query (case and spacing aside) while the first runs: one run, both answered and stamped.
    const [a, b] = await Promise.all([cache.refresh("PDF ", "cfg-1", answer(HUB)), cache.refresh("pdf", "cfg-1", answer(HUB))]);
    const joined = runs;
    const fresh = cache.peek(" pdf", "cfg-1");
    now += HUB_CACHE_FRESH_MS + 1;
    const stale = cache.peek("pdf", "cfg-1");
    const otherConfig = cache.peek("pdf", "cfg-2");
    // A cut answer (a tap rate-limited) never replaces a whole one; it is shown, never fresh, where nothing whole is.
    await cache.refresh("pdf", "cfg-1", answer(HUB.slice(0, 1), "anthropics/skills: GitHub rate limit exceeded"));
    const afterCut = cache.peek("pdf", "cfg-1");
    await cache.refresh("docx", "cfg-1", answer(HUB.slice(2), "clawhub: ClawHub request failed (503)"));
    const cutOnly = cache.peek("docx", "cfg-1");
    await cache.refresh("nothing", "cfg-1", answer([], "every source failed"));
    const failure = cache.peek("nothing", "cfg-1");
    const fromDisk = new SkillsHubCache(file, () => now).peek("pdf", "cfg-1");
    now += HUB_CACHE_MAX_AGE_MS;
    const expired = cache.peek("pdf", "cfg-1");
    writeFileSync(file, "{ not json");
    const corrupt = new SkillsHubCache(file, () => now).peek("pdf", "cfg-1");
    check(
      "T50: main keeps a whole hub answer, serves it fresh, then stale past 15 minutes, per query and config (Д45)",
      joined === 1 && !!a.ok && a.savedAt === b.savedAt && typeof a.savedAt === "number"
        && !!fresh && fresh.fresh && fresh.rows.length === 3
        && !!stale && !stale.fresh && stale.rows.length === 3 && otherConfig === null
        && !!fromDisk && fromDisk.rows.length === 3 && expired === null && corrupt === null,
      show({ joined, savedAt: [a.savedAt, b.savedAt], fresh, stale: stale && stale.fresh, otherConfig, fromDisk: fromDisk && fromDisk.rows.length, expired, corrupt }),
    );
    check(
      "T50: a cut answer never replaces a whole one, is never fresh, and a failure is not kept (Д45)",
      !!afterCut && afterCut.rows.length === 3 && afterCut.hubError === null
        && !!cutOnly && cutOnly.rows.length === 1 && !cutOnly.fresh && failure === null,
      show({ afterCut: afterCut && [afterCut.rows.length, afterCut.hubError], cutOnly: cutOnly && [cutOnly.rows.length, cutOnly.fresh], failure }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* Д45: main's IPC serves the app's own cache — a staged entry read back through window.atomic, then dropped. */
async function cacheWiring(js: Js, check: Check): Promise<void> {
  const query = "smoke-t50 wiring";
  try {
    await hubCache.refresh(query, hubConfigKey(DESKTOP_STATE_DIR), async () => ({ ok: true, rows: HUB, hubError: null }));
    const got = await safe<{ ok?: boolean; rows?: unknown[]; fresh?: boolean; savedAt?: number }>(js, `window.atomic.skillBrowseCached(${show("Smoke-T50  WIRING")})`);
    check(
      "T50: the window reads main's kept hub answer through cli:skillBrowseCached (Д45)",
      !got.err && got.ok === true && Array.isArray(got.rows) && got.rows.length === 3 && got.fresh === true && typeof got.savedAt === "number",
      got.err ?? show({ ok: got.ok, rows: got.rows ? got.rows.length : null, fresh: got.fresh }),
    );
  } finally {
    hubCache.forget(query);
  }
}

/* Д41–Д44: the installed list and its toolbar, on the three staged skills. */
async function list(js: Js, check: Check, agent: StandIn): Promise<void> {
  const r = await safe<{
    names: string[]; cols: string[]; rows: Array<{ cells: number; version: boolean }>; tabs: string[];
    hub: Array<{ blue: boolean; small: boolean; text: string }>; emptyHub: number; cta: boolean; counts: boolean; shown: boolean; readout: boolean;
    aChanged: boolean; aReadout: boolean;
  }>(js, `(async () => {
    ${PAGE}
    window.__settingsOpen('skills');
    // The staged \`atag skill list\`, past any real one that was in flight when the stand-in went on.
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 100 && SK.busy; j++) await tick(50);
      await refreshSkillList();
      if (SK.rows && SK.rows.map((x) => x.name).join() === ${show(STAGED.map((s) => s.name).join())}) break;
      await tick(100);
    }
    SKP.mode = 'list'; SKP.view = 'skills'; SKP.filter = 'all'; SKP.cursor = 0; SKP.hubCard = null; render(); await tick(30);
    const b = box();
    const empty = document.createElement('div'); empty.innerHTML = skpListHTML([]);
    const out = {names: (SK.rows || []).map((x) => x.name),
      cols: q('#settings .setbody .set-skcols > span').map((s) => s.textContent.trim()),
      rows: q('#settings .setbody [data-skill-row]').map((x) => ({cells: x.children.length, version: [...x.children].some((c) => /^v\\d/.test(c.textContent.trim()))})),
      tabs: q('#settings .setbody .set-seg button').map((x) => x.textContent.trim().replace(/\\s+/g, ' ')),
      hub: q('#settings .setbody [data-act="skills:hub"]').map((x) => ({blue: x.classList.contains('btn-blue'), small: x.classList.contains('sm'), text: x.innerText.trim()})),
      emptyHub: empty.querySelectorAll('[data-act="skills:hub"], .set-hubcta').length,
      cta: !!b.querySelector('.set-hubcta'), counts: !!b.querySelector('.set-toolbar .set-counts'), shown: / shown · /.test(b.textContent),
      readout: !!b.querySelector('[data-act="skills:auto"], .set-readout')};
    // \`a\` was the readout's key: it reaches nothing now.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const before = JSON.stringify(window.__skillsState());
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true, cancelable: true})); await tick(40);
    out.aChanged = JSON.stringify(window.__skillsState()) !== before;
    out.aReadout = !!document.querySelector('#settings .setbody [data-act="skills:auto"], #settings .setbody .set-readout');
    return out;
  })()`);
  const tools = r.err ? [] : r.tabs.filter((t) => t.startsWith("Built-in tools"));
  check(
    "T50: the installed list has no Version column (Д41)",
    !r.err && same(r.names, STAGED.map((s) => s.name)) && same(r.cols, ["Enabled", "Name", "Source", "Description"])
      && r.rows.length === 3 && r.rows.every((x) => x.cells === 4 && !x.version),
    r.err ?? show({ names: r.names, cols: r.cols, rows: r.rows }),
  );
  check(
    "T50: the filters are tabs with their counts, and no `N shown · …` line (Д43)",
    !r.err && same(r.tabs.slice(0, 3), ["All 3", "Enabled 2", "Disabled 1"]) && tools.length === 1 && !r.counts && !r.shown,
    r.err ?? show({ tabs: r.tabs, counts: r.counts, shown: r.shown }),
  );
  check(
    "T50: Browse Skills Hub is one big blue button, and the hub card under the list is gone (Д42)",
    !r.err && r.hub.length === 1 && r.hub[0]!.blue && !r.hub[0]!.small && r.hub[0]!.text === "Browse Skills Hub" && !r.cta && r.emptyHub === 0,
    r.err ?? show({ hub: r.hub, cta: r.cta, emptyHub: r.emptyHub }),
  );
  check(
    "T50: no auto / manual readout, and its `a` key reaches nothing (Д44)",
    !r.err && !r.readout && !r.aChanged && !r.aReadout,
    r.err ?? show({ readout: r.readout, aChanged: r.aChanged, aReadout: r.aReadout }),
  );

  // Refresh pressed: its button spins until the list is read again, and that is the only sign.
  agent.listHeld = true;
  const during = await safe<{ refreshing: boolean; spins: string[]; disabled: boolean }>(js, `(async () => {
    ${PAGE}
    const btn = document.querySelector('#settings .setbody .set-toolbar [data-act="skills:refresh"]');
    if (!btn) return {err: 'no Refresh button in the Skills toolbar'};
    btn.click(); await tick(60);
    const now = document.querySelector('#settings .setbody .set-toolbar [data-act="skills:refresh"]');
    return {refreshing: SKP.listRefreshing, spins: spins(), disabled: !!now && now.disabled};
  })()`);
  agent.releaseLists();
  const after = await safe<{ refreshing: boolean; spins: string[]; icon: boolean }>(js, `(async () => {
    ${PAGE}
    for (let i = 0; i < 60 && SKP.listRefreshing; i++) await tick(50);
    const now = document.querySelector('#settings .setbody .set-toolbar [data-act="skills:refresh"]');
    return {refreshing: SKP.listRefreshing, spins: spins(), icon: !!now && !now.disabled && !!now.querySelector('svg')};
  })()`);
  check(
    "T50: a pressed Refresh spins its own button until the list is read, nothing else (Д44)",
    !during.err && !after.err && during.refreshing && same(during.spins, ["skills:refresh"]) && during.disabled
      && !after.refreshing && after.spins.length === 0 && after.icon,
    during.err ?? after.err ?? show({ during, after }),
  );
}

/* Д44: `manual` cut the counts off. On the narrowest window (minWidth 940) every tab's count is whole. */
async function narrow(js: Js, check: Check): Promise<void> {
  const win = appWindow();
  if (!win) { check("T50: on the narrowest window every tab and its count is whole (Д44)", false, "no app window to resize"); return; }
  const size = win.getContentSize();
  try {
    win.setContentSize(940, size[1]!);
    await wait(500);
    const fit = await safe<{ width: number; tabs: Array<{ t: string; whole: boolean }>; seg: boolean; row: boolean; hubOn: boolean }>(js, `(async () => {
      ${PAGE}
      window.__settingsOpen('skills'); SKP.mode = 'list'; SKP.view = 'skills'; render(); await tick(120);
      const seg = document.querySelector('#settings .set-toolbar .set-seg');
      if (!seg) return {err: 'no tabs in the Skills toolbar'};
      const row = seg.closest('.set-tbrow');
      const edge = row.getBoundingClientRect().right;
      const hubBtn = row.querySelector('[data-act="skills:hub"]');
      return {width: window.innerWidth,
        tabs: [...seg.querySelectorAll('button')].map((b) => { const n = b.querySelector('.n'); const br = b.getBoundingClientRect();
          return {t: b.textContent.trim().replace(/\\s+/g, ' '), whole: b.scrollWidth <= b.clientWidth + 1 && (!n || (n.getClientRects().length > 0 && n.getBoundingClientRect().right <= br.right + 0.5)) && br.right <= edge + 1}; }),
        seg: seg.scrollWidth <= seg.clientWidth + 1, row: row.scrollWidth <= row.clientWidth + 1,
        hubOn: !!hubBtn && hubBtn.getBoundingClientRect().right <= edge + 1};
    })()`);
    check(
      "T50: on the narrowest window every tab and its count is whole, Browse Skills Hub on screen (Д44)",
      !fit.err && fit.width <= 1000 && fit.tabs.length === 4 && fit.tabs.every((t) => t.whole) && fit.seg && fit.row && fit.hubOn,
      fit.err ?? show(fit),
    );
  } finally {
    const now = win.getContentSize();
    if (now[0] !== size[0] || now[1] !== size[1]) { win.setContentSize(size[0]!, size[1]!); await wait(400); }
  }
}

/* What the hub view shows, read the moment it is asked. */
const HUB_VIEW = `(() => {
  ${PAGE}
  const b = box();
  const again = b && b.querySelector('[data-act="skills:rebrowse"]');
  return {mode: SKP.mode, loading: SKP.hubLoading, rows: hubRows(), skel: q('#settings .setbody .set-skel .tk-li').length, spins: spins(),
    counts: ((b && b.querySelector('.set-toolbar .set-counts')) || {}).textContent || '', againDisabled: !!again && again.disabled,
    oldLoader: !!b && /browsing the skill hub|loading skill card/.test(b.textContent), error: SKP.hubError || ''};
})()`;
type HubView = { mode: string; loading: boolean; rows: string[]; skel: number; spins: string[]; counts: string; againDisabled: boolean; oldLoader: boolean; error: string };
/* Into the hub as after a fresh start: nothing of it in the window's memory, so main's kept answer is all there is. */
const OPEN_HUB = `(async () => {
  window.__skillsAct('back'); window.__skillsAct('back');
  SKP.hubRows = []; SKP.hubFor = null; SKP.hubSavedAt = null; SKP.hubError = null; SKP.msg = null;
  window.__skillsAct('hub');
  await new Promise((r) => setTimeout(r, 40));
  return true;
})()`;

async function hub(js: Js, check: Check, agent: StandIn): Promise<void> {
  const ids = HUB.map((r) => r.identifier);
  const view = () => safe<HubView>(js, HUB_VIEW);
  const settle = async (ok: (v: HubView) => boolean): Promise<HubView & Failed> => {
    let v = await view();
    for (let i = 0; i < 40 && !v.err && !ok(v); i++) { await wait(50); v = await view(); }
    return v;
  };

  // 1 — Nothing kept: placeholder rows, and nothing else that spins.
  agent.kept = { ok: false };
  agent.browseHeld = true;
  let calls = agent.browses.length;
  await safe<boolean>(js, OPEN_HUB);
  const first = await view();
  const asked = await until(() => agent.browses.length > calls, 3000);
  agent.releaseBrowses({ ok: true, rows: HUB, hubError: null });
  const firstDone = await settle((v) => !v.loading);
  check(
    "T50: the hub's first browse shows placeholder rows and nothing else that spins (Д45)",
    !first.err && !firstDone.err && asked && first.mode === "hub" && first.loading && first.skel === 8 && first.spins.length === 0
      && first.rows.length === 0 && first.counts === "" && !first.oldLoader
      && same(firstDone.rows, ids) && firstDone.skel === 0 && firstDone.spins.length === 0 && firstDone.counts === "3 results",
    first.err ?? firstDone.err ?? show({ asked, first, firstDone }),
  );

  // 2 — A kept answer that is no longer fresh: on screen at once, newer rows on the way under Browse again's spinner.
  agent.kept = { ok: true, rows: HUB.slice(0, 2), hubError: null, savedAt: Date.now() - 2 * 3600_000, fresh: false };
  agent.browseHeld = true;
  calls = agent.browses.length;
  await safe<boolean>(js, OPEN_HUB);
  const kept = await settle((v) => v.rows.length > 0);
  const refetched = await until(() => agent.browses.length > calls, 3000);
  agent.releaseBrowses({ ok: true, rows: HUB, hubError: null });
  const replaced = await settle((v) => !v.loading);
  check(
    "T50: a kept answer shows at once, with only Browse again's spinner while newer rows come (Д45)",
    !kept.err && !replaced.err && refetched && same(kept.rows, ids.slice(0, 2)) && kept.skel === 0 && same(kept.spins, ["skills:rebrowse"])
      && kept.againDisabled && same(replaced.rows, ids) && replaced.spins.length === 0 && !replaced.againDisabled,
    kept.err ?? replaced.err ?? show({ refetched, kept, replaced }),
  );

  // 3 — A fresh kept answer asks the hub nothing; Browse again goes past it.
  agent.kept = { ok: true, rows: HUB.slice(0, 2), hubError: null, savedAt: Date.now() - 60_000, fresh: true };
  agent.browseHeld = true;
  calls = agent.browses.length;
  await safe<boolean>(js, OPEN_HUB);
  const fresh = await settle((v) => v.rows.length > 0);
  await wait(300);
  const quiet = agent.browses.length === calls;
  await safe<void>(js, "(() => { const b = document.querySelector('#settings .setbody [data-act=\"skills:rebrowse\"]'); if (b) b.click(); })()");
  const forced = await until(() => agent.browses.length > calls, 3000);
  const during = await view();
  agent.releaseBrowses({ ok: true, rows: HUB, hubError: null });
  const done = await settle((v) => !v.loading);
  check(
    "T50: a fresh kept answer asks the hub nothing; Browse again does, the rows staying meanwhile (Д45)",
    !fresh.err && !during.err && !done.err && quiet && !fresh.loading && same(fresh.rows, ids.slice(0, 2)) && fresh.spins.length === 0
      && forced && same(during.rows, ids.slice(0, 2)) && same(during.spins, ["skills:rebrowse"]) && same(done.rows, ids),
    fresh.err ?? during.err ?? done.err ?? show({ quiet, forced, fresh, during, done }),
  );

  // 4 — The hub does not answer: the kept rows stay, and the note says how old they are.
  agent.kept = { ok: true, rows: HUB.slice(0, 2), hubError: null, savedAt: Date.now() - 2 * 3600_000 - 60_000, fresh: false };
  agent.browseHeld = false;
  agent.browseAnswer = { ok: false, error: "smoke t50: offline" };
  await safe<boolean>(js, OPEN_HUB);
  const offline = await settle((v) => !v.loading && v.error !== "");
  agent.browseAnswer = { ok: true, rows: HUB, hubError: null };
  agent.browseHeld = true;
  check(
    "T50: a refresh that fails keeps the kept rows and says how old they are (Д45)",
    !offline.err && same(offline.rows, ids.slice(0, 2))
      && offline.error === "Could not refresh the Skills Hub: smoke t50: offline. Showing the list from 2 hours ago.",
    offline.err ?? show(offline),
  );

  // Back on the staged rows for the skill pages.
  agent.kept = { ok: true, rows: HUB, hubError: null, savedAt: Date.now() - 60_000, fresh: true };
  await safe<boolean>(js, OPEN_HUB);
  await settle((v) => v.rows.length === 3);
}

/* What the skill page shows: its head, its geometry and its one loader. */
const CARD_VIEW = `(() => {
  ${PAGE}
  const b = box();
  const c = SKP.hubCard;
  if (!b || !c) return {card: false, loading: SKP.hubCardLoading, mode: SKP.mode};
  const back = b.querySelector('[data-act="skills:back"]');
  const title = b.querySelector('.set-cardhead .set-dtitle');
  const head = b.querySelector('.set-cardtitle');
  const install = b.querySelector('[data-act="skills:install"]');
  const pane = b.querySelector('.set-pane');
  const src = b.querySelector('[data-act="skills:source"]');
  const pre = b.querySelector('.set-srcbody');
  const r = (el) => el ? el.getBoundingClientRect() : null;
  const br = r(back), tr = r(title), hr = r(head), ir = r(install), pr = r(pane);
  return {card: true, loading: SKP.hubCardLoading, mode: SKP.mode, id: c.identifier,
    title: title ? title.textContent.trim() : '', meta: ((b.querySelector('.set-cardmeta')) || {}).textContent || '',
    chips: b.querySelectorAll('.tk-chip').length, spins: spins(), installOn: !!install && !install.disabled,
    source: src ? src.innerText.trim() : '', pre: pre ? pre.textContent : null,
    note: ((b.querySelector('.set-softnote')) || {}).textContent || '',
    backLeft: br && back ? br.left + parseFloat(getComputedStyle(back).paddingLeft) : null, titleLeft: tr ? tr.left : null,
    installMid: ir ? (ir.top + ir.bottom) / 2 : null, headMid: hr ? (hr.top + hr.bottom) / 2 : null,
    installRight: ir ? ir.right : null, paneRight: pr ? pr.right : null};
})()`;
type CardView = {
  card: boolean; loading: boolean; mode: string; id?: string; title?: string; meta?: string; chips?: number; spins?: string[]; installOn?: boolean;
  source?: string; pre?: string | null; note?: string; backLeft?: number | null; titleLeft?: number | null; installMid?: number | null;
  headMid?: number | null; installRight?: number | null; paneRight?: number | null;
};
const near = (a: number | null | undefined, b: number | null | undefined) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1.5;

async function page(js: Js, check: Check, agent: StandIn): Promise<void> {
  const card = () => safe<CardView>(js, CARD_VIEW);
  const act = (what: string) => safe<unknown>(js, `window.__skillsAct(${show(what)})`);

  // 1 — The page is up the moment the row is pressed; only its source waits for ClawHub.
  agent.detailHeld = true;
  let asked = agent.details.length;
  await act("card:0");
  await wait(40);
  const early = await card();
  const reached = await until(() => agent.details.length > asked, 8000);
  agent.releaseDetails();
  let filled = await card();
  for (let i = 0; i < 40 && !filled.err && filled.loading; i++) { await wait(50); filled = await card(); }
  check(
    "T50: a skill page is up at once from its row, and ClawHub's detail fills it in (Д45, Д46)",
    !early.err && !filled.err && reached && early.card && early.loading && early.title === "smoke-t50-improver"
      && early.meta === "482k downloads · by pskoett" && !!early.installOn && same(early.spins, ["set-srcwait"])
      && filled.card && !filled.loading && filled.title === "Smoke T50 Improver" && filled.meta === "482k downloads · by pskoett · v4.0.2"
      && filled.source === "Show source" && filled.pre === null && (filled.spins ?? []).length === 0,
    early.err ?? filled.err ?? show({ reached, early, filled }),
  );
  check(
    "T50: no claw badge; Results flush with the title, Install on the title's line at the right edge (Д46)",
    !filled.err && filled.chips === 0 && near(filled.backLeft, filled.titleLeft) && near(filled.installMid, filled.headMid)
      && near(filled.installRight, filled.paneRight),
    filled.err ?? show({ chips: filled.chips, backLeft: filled.backLeft, titleLeft: filled.titleLeft, installMid: filled.installMid,
      headMid: filled.headMid, installRight: filled.installRight, paneRight: filled.paneRight }),
  );

  // 2 — Show source unfolds the whole published SKILL.md, and folds it again.
  await act("source");
  const open = await card();
  await act("source");
  const shut = await card();
  check(
    "T50: Show source unfolds the whole SKILL.md and folds it again (Д46)",
    !open.err && !shut.err && open.source === "Hide source" && open.pre === SKILL_MD && shut.source === "Show source" && shut.pre === null,
    open.err ?? shut.err ?? show({ open: [open.source, open.pre && open.pre.length], shut: [shut.source, shut.pre] }),
  );

  // 3 — Back while the detail is out: its late answer is kept for the session, never drawn; the next opening is at once.
  await act("back");
  agent.detailHeld = true;
  asked = agent.details.length;
  await act("card:1");
  const out = await until(() => agent.details.length > asked, 8000);
  await act("back");
  agent.releaseDetails();
  await wait(150);
  const left = await card();
  const before = agent.details.length;
  await act("card:1");
  await wait(40);
  const again = await card();
  check(
    "T50: a detail that answers after Back is not drawn, and opens the page at once next time (Д45)",
    !left.err && !again.err && out && !left.card && !left.loading && left.mode === "hub"
      && again.card && !again.loading && again.title === "Late smoke-t50-pdf" && agent.details.length === before,
    left.err ?? again.err ?? show({ out, left, again, asked: agent.details.length - before }),
  );

  // 4 — A GitHub tap's page: where it comes from in words, no badge, nothing asked of ClawHub.
  await act("back");
  const ghBefore = agent.details.length;
  await act("card:2");
  await wait(40);
  const gh = await card();
  check(
    "T50: a GitHub tap's page says where it comes from, without a badge (Д46)",
    !gh.err && gh.card && gh.title === "smoke-t50-docx" && gh.meta === "From GitHub · anthropics/skills" && gh.chips === 0
      && !!gh.installOn && /preview unavailable for GitHub taps/.test(gh.note ?? "") && agent.details.length === ghBefore,
    gh.err ?? show(gh),
  );
  await act("back");
}
