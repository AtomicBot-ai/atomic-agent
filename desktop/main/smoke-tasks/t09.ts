import { BrowserWindow } from "electron";

/**
 * Release-fix checks for backlog item 09 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=09`.
 *
 * 09 — Settings › Skills › Built-in tools closed Settings for the inspector's
 * World tab, which shell.css hides below 1180px: the user landed on an empty
 * chat. It is a segment of the Skills pane now, and `/tools` (the palette's
 * List built-in tools, Help › List built-in tools) lands on it at every width.
 * Every block puts back what it staged: LIVE_CAPS, the Skills pane's segment,
 * filter and cursor, the functions it spied on, the inspector, the window
 * size, Settings closed.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/* The renderer's rule, restated: the MCP servers' own tools are out, the agent's native mcp.resource.* / mcp.prompt.* stay. */
const builtIn = (name: string) => !name.startsWith("mcp.") || /^mcp\.(resource|prompt)\./.test(name);

/* A renderer error is a failed check, never a thrown one: a throw would leave
   checks09 for the smoke runner, which has no catch, and the app would keep
   running with nothing to stop it. Each check reads the fields only when
   there is no `err`. */
async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return await js<T & Failed>(code);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

/** The app window the smoke drives (the renderer's index.html). */
function appWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\.html$/.test(w.webContents.getURL())) ?? null;
}

/* Where `/tools` landed, read the moment it returns: Settings and its pane,
   the Skills segment, the painted tool rows, and whether the inspector would
   be drawn at this width (it is forced open for the reading, then put back). */
const LANDING = `(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const saved = {inspector: S.inspector, inspTab: S.inspTab, view: SKP.view};
  try {
    window.__settingsClose();
    S.inspector = true; render();
    const inspectorShown = getComputedStyle(document.getElementById('inspector')).display !== 'none';
    window.__runSlash('/tools'); await tick(250);
    return {width: window.innerWidth, inspectorShown, pane: window.__settingsPane(), view: SKP.view,
      rows: document.querySelectorAll('#settings [data-tool-row]').length, inspTabMoved: S.inspTab !== saved.inspTab};
  } finally {
    window.__settingsClose();
    S.inspector = saved.inspector; S.inspTab = saved.inspTab; SKP.view = saved.view; render();
  }
})()`;
type Landing = { width: number; inspectorShown: boolean; pane: string | null; view: string; rows: number; inspTabMoved: boolean };

export async function checks09(js: Js, check: Check): Promise<void> {
  try {
    await run(js, check);
  } catch (e) {
    check("T09: the item-09 checks ran to the end", false, message(e));
  }
}

async function run(js: Js, check: Check): Promise<void> {
  // The pane's own control, found by its words so the same click reaches the
  // old toolbar button (data-act="menu:help.tools") when the fix is reverted.
  // The capabilities are staged: built-in tools in three families, one
  // unprefixed, one of the agent's native MCP discovery tools (it stays) and
  // one tool of an MCP server (it goes).
  const r = await safe<{
    pane: string | null; overlay: string | null; inspectorMoved: boolean; pressed: string[];
    rows: string[]; families: string[]; desc: string; counts: string; skillRows: number; back: string; backPressed: string[];
  }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const q = (s) => [...document.querySelectorAll(s)];
    const saved = {caps: LIVE_CAPS, view: SKP.view, filter: SKP.filter, cursor: SKP.cursor, inspector: S.inspector, inspTab: S.inspTab};
    try {
      window.__settingsOpen('skills');
      LIVE_CAPS = Object.assign({}, saved.caps, {tools: [
        {name:'os.fs.write', description:'Write a file.'},
        {name:'mcp.smoke.echo', description:'A tool of an MCP server.'},
        {name:'browser.navigate', description:'Open a URL in the active tab.'},
        {name:'mcp.resource.list', description:'List the resources of the MCP servers.'},
        {name:'reply', description:'Answer the user.'},
        {name:'os.fs.read', description:'Read a UTF-8 text file.'},
      ]});
      render(); await tick(60);
      const btn = q('#settings .setbody .set-toolbar button').find((b) => b.textContent.trim() === 'Built-in tools');
      if (!btn) return {err:'no Built-in tools control in the Skills toolbar'};
      btn.click(); await tick(150);
      const out = {pane: window.__settingsPane(), overlay: S.overlay,
        inspectorMoved: S.inspector !== saved.inspector || S.inspTab !== saved.inspTab,
        pressed: q('#settings .setbody .set-seg button.on').map((b) => b.textContent.trim()),
        rows: q('#settings [data-tool-row]').map((x) => x.dataset.toolRow),
        families: q('#settings .set-tlfam').map((x) => x.textContent.trim()),
        desc: ((document.querySelector('#settings [data-tool-row="os.fs.read"] .d') || {}).textContent || ''),
        counts: ((document.querySelector('#settings .set-toolbar .set-counts') || {}).textContent || '').trim(),
        skillRows: q('#settings [data-skill-row]').length};
      // A filter segment is the way back to the skills.
      const all = document.querySelector('#settings .set-seg [data-act="skills:filter:all"]');
      if (all) { all.click(); await tick(100); }
      out.back = SKP.view;
      out.backPressed = q('#settings .setbody .set-seg button.on').map((b) => b.textContent.trim());
      return out;
    } finally {
      LIVE_CAPS = saved.caps; SKP.view = saved.view; SKP.filter = saved.filter; SKP.cursor = saved.cursor;
      if (S.inspector !== saved.inspector || S.inspTab !== saved.inspTab) {
        S.inspector = saved.inspector; S.inspTab = saved.inspTab; writePaneFlag('atag.inspector', saved.inspector);
      }
      window.__settingsClose();
    }
  })()`);
  check(
    "T09: Settings › Skills › Built-in tools stays in Settings and shows the tools there",
    !r.err && r.pane === "skills" && !r.overlay && !r.inspectorMoved && same(r.pressed, ["Built-in tools"]) && r.skillRows === 0 && r.rows.length > 0,
    r.err ?? JSON.stringify({ pane: r.pane, overlay: r.overlay, inspectorMoved: r.inspectorMoved, pressed: r.pressed, rows: r.rows.length, skillRows: r.skillRows }),
  );
  check(
    "T09: the list is name and description, grouped by family, without the MCP servers' own tools",
    !r.err && same(r.rows, ["reply", "browser.navigate", "mcp.resource.list", "os.fs.read", "os.fs.write"])
      && same(r.families, ["browser", "mcp.resource", "os.fs"]) && r.desc === "Read a UTF-8 text file." && r.counts === "5 tools",
    r.err ?? JSON.stringify({ rows: r.rows, families: r.families, desc: r.desc, counts: r.counts }),
  );
  check(
    "T09: a filter segment goes back to the skills",
    !r.err && r.back === "skills" && same(r.backPressed, ["all"]),
    r.err ?? JSON.stringify({ back: r.back, pressed: r.backPressed }),
  );

  // The live list: what GET /api/capabilities answers, less the MCP servers' tools, through `/tools`.
  const live = await safe<{ names: string[] | null; rows: string[]; pane: string | null; view: string; counts: string }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const res = await window.atomic.capabilities();
    const v = SKP.view;
    try {
      window.__runSlash('/tools'); await tick(300);
      return {names: res && res.ok && res.data && Array.isArray(res.data.tools) ? res.data.tools.map((t) => t.name) : null,
        rows: [...document.querySelectorAll('#settings [data-tool-row]')].map((x) => x.dataset.toolRow),
        pane: window.__settingsPane(), view: SKP.view,
        counts: ((document.querySelector('#settings .set-toolbar .set-counts') || {}).textContent || '').trim()};
    } finally { window.__settingsClose(); SKP.view = v; }
  })()`);
  const want = live.err || !live.names ? null : live.names.filter(builtIn).sort();
  check(
    "T09: /tools lists the agent's GET /api/capabilities tools, less the MCP servers' own",
    !live.err && !!want && want.length > 0 && live.pane === "skills" && live.view === "tools"
      && same(live.rows.slice().sort(), want) && live.counts === `${want.length} tools`,
    live.err ?? `${live.rows.length} rows, ${want ? want.length : "no"} built-in of ${live.names ? live.names.length : "no"} from the route; pane=${live.pane} view=${live.view} counts=${JSON.stringify(live.counts)}`,
  );

  // Nothing read yet. The agent still starting: the calm line. A read that
  // fails with the agent up: skpToolsRefresh's own failure branch, through a
  // stand-in for the bridge. `/tools` with the agent up: it says it is
  // loading, asks the agent itself, and lists the tools once it answers.
  const empty = await safe<{ calm: string; failed: string; failedKept: boolean; state: string; loading: boolean; text: string; spinner: boolean; rows0: number; rows: number; filled: boolean }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const box = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.trim(); };
    const saved = {caps: LIVE_CAPS, err: SKP.toolsError, live: S.live, view: SKP.view};
    let staged = null;
    try {
      staged = S.live = Object.assign({}, saved.live, {state: 'starting'}); SKP.toolsLoading = true; SKP.toolsError = null;
      const calm = box(skpToolsHTML(null));
      S.live = saved.live; staged = null; SKP.toolsLoading = false;
      LIVE_CAPS = null;
      await skpToolsRefresh(async () => ({ok:false, error:'HTTP 500 (smoke)'}));
      const failed = box(skpToolsHTML(null));
      const failedKept = LIVE_CAPS === null;
      SKP.toolsError = null;
      window.__settingsClose();
      window.__runSlash('/tools');
      const loading = SKP.toolsLoading;
      const text = ((document.querySelector('#settings .setbody .tk-empty') || {}).textContent || '').trim();
      const spinner = !!document.querySelector('#settings .setbody .tk-empty .tk-spin');
      const rows0 = document.querySelectorAll('#settings [data-tool-row]').length;
      let rows = 0;
      for (let i = 0; i < 40 && !rows; i++) { await tick(250); rows = document.querySelectorAll('#settings [data-tool-row]').length; }
      return {calm, failed, failedKept, state: S.live.state, loading, text, spinner, rows0, rows, filled: !!LIVE_CAPS};
    } finally {
      if (staged && S.live === staged) S.live = saved.live;
      if (!LIVE_CAPS) LIVE_CAPS = saved.caps;
      SKP.toolsError = saved.err; SKP.view = saved.view;
      window.__settingsClose();
    }
  })()`);
  check(
    "T09: with nothing read yet, /tools says it is loading, asks the agent, then lists the tools",
    !empty.err && empty.loading && empty.spinner && empty.text === "loading the tool list…" && empty.rows0 === 0 && empty.rows > 0 && empty.filled,
    empty.err ?? JSON.stringify({ text: empty.text, loading: empty.loading, spinner: empty.spinner, rows0: empty.rows0, rows: empty.rows, filled: empty.filled }),
  );
  check(
    "T09: the empty state is calm while the agent starts, and says so when a read fails with the agent up",
    !empty.err && empty.calm === "The list appears when the agent is up." && empty.state === "connected"
      && /did not list its tools \(HTTP 500 \(smoke\)\)/.test(empty.failed) && empty.failedKept,
    empty.err ?? JSON.stringify({ calm: empty.calm, state: empty.state, failed: empty.failed, failedKept: empty.failedKept }),
  );

  // The keys of a list with no skill row on screen: e and d must not reach a
  // skill. skpToggle / skpRequestRemove are spied on (the skills list's own e
  // proves the spy is in the path, once `atag skill list` has given it a row
  // to act on), so a regression cannot touch a skill.
  const keys = await safe<{ wired: boolean; calls: string[]; viewAfterE: string; scrolled: number; viewAfterF: string; topAfterF: number; room: number }>(js, `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true}));
    const saved = {view: SKP.view, filter: SKP.filter, cursor: SKP.cursor, toggle: window.skpToggle, remove: window.skpRequestRemove};
    const calls = [];
    try {
      window.skpToggle = (name) => { calls.push('toggle:' + name); };
      window.skpRequestRemove = (name) => { calls.push('remove:' + name); };
      window.__settingsOpen('skills'); await tick(60);
      for (let i = 0; i < 80 && !skpSelected(); i++) await tick(250);
      if (!skpSelected()) return {err: 'atag skill list gave the Skills pane no row in 20 s'};
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      key('e'); await tick(30);
      const wired = calls.length === 1 && calls[0].startsWith('toggle:');
      calls.length = 0;
      window.__skillsAct('tools'); await tick(60);
      if (SKP.view !== 'tools') return {err: 'no Built-in tools segment to press keys in'};
      key('e'); key('d'); await tick(60);
      const out = {wired, calls: calls.slice(), viewAfterE: SKP.view};
      // Down the long list, then back: the skills start at their top, not at the tools' offset.
      const body = () => document.querySelector('#settings .setbody');
      body().scrollTop = 600; await tick(30);
      out.scrolled = body().scrollTop;
      key('f'); await tick(60);
      out.viewAfterF = SKP.view; out.topAfterF = body() ? body().scrollTop : -1;
      out.room = body() ? body().scrollHeight - body().clientHeight : 0; // > 0: the skills list scrolls, so a kept offset would show
      return out;
    } finally {
      window.skpToggle = saved.toggle; window.skpRequestRemove = saved.remove;
      SKP.view = saved.view; SKP.filter = saved.filter; SKP.cursor = saved.cursor;
      window.__settingsClose();
    }
  })()`);
  check(
    "T09: in the tools list e and d reach no skill; f goes back to the skills, at their top",
    !keys.err && keys.wired && keys.calls.length === 0 && keys.viewAfterE === "tools"
      && keys.scrolled > 0 && keys.viewAfterF === "skills" && keys.topAfterF === 0 && keys.room > 0,
    keys.err ?? JSON.stringify(keys),
  );

  // The segment is picked, not remembered: Skills opened again shows its skills
  // (the full suite's Skills checks enter that way and read the filter bar).
  const reopen = await safe<{ view: string; pressed: string[] }>(js, `(() => {
    const v = SKP.view;
    try {
      window.__runSlash('/tools'); window.__settingsClose(); window.__settingsOpen('skills');
      return {view: SKP.view, pressed: [...document.querySelectorAll('#settings .setbody .set-seg button.on')].map((b) => b.textContent.trim())};
    } finally { window.__settingsClose(); SKP.view = v; }
  })()`);
  check(
    "T09: Skills opened again shows its skills, not the tools",
    !reopen.err && reopen.view === "skills" && reopen.pressed.length === 1 && reopen.pressed[0] !== "Built-in tools",
    reopen.err ?? JSON.stringify(reopen),
  );

  // Help › List built-in tools — exactly the full suite's "a menu verb
  // dispatches its desktop act" (main.ts), so its new expectation is proved here too.
  const verb = await safe<{ settings: boolean; pane: string | null; view: string; overlay: string | null }>(js, `(() => {
    const v = SKP.view;
    try {
      window.__settingsClose();
      return Object.assign(window.__menuActivate('help.tools'), {view: window.__skillsState().view});
    } finally { window.__settingsClose(); SKP.view = v; }
  })()`);
  check(
    "T09: Help › List built-in tools opens the same segment (the full suite's menu-verb check)",
    !verb.err && verb.settings && verb.pane === "skills" && verb.view === "tools" && !verb.overlay,
    verb.err ?? JSON.stringify(verb),
  );

  // The palette's List built-in tools, as a person reaches it: open the
  // palette, type into its search box, click the row.
  const PALETTE = `(async () => {
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const v = SKP.view;
    try {
      window.__settingsClose();
      act('palette'); await tick(60);
      const box = document.getElementById('palq');
      if (!box) return {err: 'the palette did not open'};
      box.value = 'built-in tools'; box.dispatchEvent(new Event('input', {bubbles: true})); await tick(60);
      const row = [...document.querySelectorAll('#overlays [data-palrow]')].find((el) => el.textContent.includes('List built-in tools'));
      if (!row) return {err: 'no List built-in tools row for "built-in tools"'};
      row.click(); await tick(250);
      return {pane: window.__settingsPane(), view: SKP.view, overlay: S.overlay, rows: document.querySelectorAll('#settings [data-tool-row]').length};
    } finally { act('close'); window.__settingsClose(); SKP.view = v; }
  })()`;
  type Palette = { pane: string | null; view: string; overlay: string | null; rows: number };

  // The bug's own window: too narrow for the inspector. A real resize, so
  // the CSS rule that hid the panel is the one in force, then the narrowest
  // window the app allows (minWidth 940) for the toolbar, then a wide one.
  const win = appWindow();
  if (!win) {
    check("T09: on a window too narrow for the inspector, /tools lands on Settings › Skills › Built-in tools", false, "no app window to resize");
    return;
  }
  const size = win.getContentSize();
  try {
    win.setContentSize(1100, size[1]!);
    await wait(500);
    const narrow = await safe<Landing>(js, LANDING);
    check(
      "T09: on a window too narrow for the inspector, /tools lands on Settings › Skills › Built-in tools",
      !narrow.err && narrow.width < 1180 && !narrow.inspectorShown && narrow.pane === "skills" && narrow.view === "tools" && narrow.rows > 0,
      narrow.err ?? JSON.stringify(narrow),
    );
    const pal = await safe<Palette>(js, PALETTE);
    check(
      "T09: the palette's List built-in tools lands there too",
      !pal.err && pal.pane === "skills" && pal.view === "tools" && !pal.overlay && pal.rows > 0,
      pal.err ?? JSON.stringify(pal),
    );

    win.setContentSize(940, size[1]!);
    await wait(500);
    type Fit = { fits: boolean; over: number; hub: boolean } | null;
    const fit = await safe<{ width: number; skills: Fit; tools: Fit; names: number; clipped: string[] }>(js, `(async () => {
      const tick = (ms) => new Promise((res) => setTimeout(res, ms));
      const saved = {view: SKP.view};
      const measure = () => {
        const row = document.querySelector('#settings .set-toolbar .set-tbrow');
        if (!row) return null;
        const edge = row.getBoundingClientRect().right;
        const last = [...row.children].pop();
        return {fits: row.scrollWidth <= row.clientWidth + 1 && !!last && last.getBoundingClientRect().right <= edge + 1,
          over: row.scrollWidth - row.clientWidth, hub: !!row.querySelector('[data-act="skills:hub"]')};
      };
      try {
        window.__settingsOpen('skills'); await tick(120);
        const skills = measure();
        window.__skillsAct('tools'); await tick(120);
        const names = [...document.querySelectorAll('#settings [data-tool-row] .t')];
        return {width: window.innerWidth, skills, tools: measure(), names: names.length,
          clipped: names.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent)};
      } finally { SKP.view = saved.view; window.__settingsClose(); }
    })()`);
    check(
      "T09: on the narrowest window the Skills toolbar still fits, Browse Skills Hub on screen, in both segments",
      !fit.err && fit.width <= 1000 && !!fit.skills && fit.skills.fits && fit.skills.hub && !!fit.tools && fit.tools.fits && fit.tools.hub,
      fit.err ?? JSON.stringify({ width: fit.width, skills: fit.skills, tools: fit.tools }),
    );
    check(
      "T09: on the narrowest window every tool name is shown whole",
      !fit.err && fit.names > 0 && fit.clipped.length === 0,
      fit.err ?? `${fit.names} names; cut: ${JSON.stringify(fit.clipped)}`,
    );

    win.setContentSize(1280, size[1]!);
    await wait(500);
    const wide = await safe<Landing>(js, LANDING);
    check(
      "T09: on a wide window /tools lands on the same segment and leaves the inspector's tab alone",
      !wide.err && wide.width > 1180 && wide.inspectorShown && wide.pane === "skills" && wide.view === "tools" && wide.rows > 0 && !wide.inspTabMoved,
      wide.err ?? JSON.stringify(wide),
    );
  } finally {
    const now = win.getContentSize();
    if (now[0] !== size[0] || now[1] !== size[1]) { win.setContentSize(size[0]!, size[1]!); await wait(400); }
    await safe<void>(js, "window.__settingsClose()");
  }
}
