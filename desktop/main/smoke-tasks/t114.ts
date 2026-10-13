import { BrowserWindow } from "electron";

/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=114`.
 *
 * The owner's 13.10 review of the window chrome, three parts:
 * (a) Settings wore a ring with eight loose rays — the theme picker's sun at
 *     16px. It is a cog now (six teeth round a hub), in the sidebar's Settings
 *     row and everywhere else `ic('gear')` stands for Settings.
 * (b) The empty chat's greeting and the mark beside it are 1.3× (26px type,
 *     a 39px mark), in proportion, and they do not overflow the column on the
 *     narrowest window the app allows (940px).
 * (c) The Atomic Chat layout. Expanded, the sidebar reaches up into the 52px
 *     band: its top row holds the traffic lights on the left and two icon
 *     buttons on the right — Search (the palette, ⌘ K) and the sidebar
 *     toggle. The "Search" pill at the top right of the main area is gone.
 *     Collapsed, both buttons stand in the toolbar next to the lights.
 *     The row is the drag handle; the buttons are not.
 * (d) The inspector toggle at the top right wore the sidebar's panel glyph
 *     mirrored and was taken for the sidebar button; it shows steps now.
 *
 * The sidebar state and the window size are put back; nothing is written.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Where the chrome's two buttons are, read off the live DOM. */
const CHROME = String.raw`(() => {
  const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect();
    return {left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom),
      width: Math.round(b.width), height: Math.round(b.height)}; };
  const btn = (n) => n ? {act: n.dataset.act, title: n.getAttribute('title'), aria: n.getAttribute('aria-label'),
    disabled: !!n.disabled, tab: n.tabIndex, box: r(n), region: getComputedStyle(n).webkitAppRegion || '',
    hit: (() => { const b = n.getBoundingClientRect(); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!h && n.contains(h); })(),
    svg: !!n.querySelector('svg')} : null;
  const top = document.querySelector('#sidebar .sb-top');
  const tb = document.querySelector('#toolbar');
  const title = document.querySelector('#toolbar .tb-title');
  return {
    expanded: sidebarExpanded(), state: S.sidebar, electron: document.body.classList.contains('electron'),
    darwin: document.body.classList.contains('platform-darwin'),
    top: top ? {box: r(top), region: getComputedStyle(top).webkitAppRegion || '',
      buttons: [...top.querySelectorAll('button')].map(btn)} : null,
    toolbar: {open: tb.classList.contains('sb-open'), region: getComputedStyle(tb).webkitAppRegion || '',
      buttons: [...tb.querySelectorAll('[data-act="palette"], [data-act="toggle:sidebar"]')].map(btn),
      titleLeft: title ? Math.round(title.getBoundingClientRect().left) : null},
    pill: document.querySelectorAll('.searchbtn').length,
    palettes: document.querySelectorAll('#toolbar [data-act="palette"], #sidebar [data-act="palette"]').length,
    toggles: document.querySelectorAll('[data-act="toggle:sidebar"]').length,
    sidebar: r(document.querySelector('#sidebar')), main: r(document.querySelector('#main')),
  };
})()`;

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Btn = { act: string; title: string | null; aria: string | null; disabled: boolean; tab: number; box: Box; region: string; hit: boolean; svg: boolean };
type Chrome = {
  expanded: boolean; state: string; electron: boolean; darwin: boolean;
  top: { box: Box; region: string; buttons: Btn[] } | null;
  toolbar: { open: boolean; region: string; buttons: Btn[]; titleLeft: number | null };
  pill: number; palettes: number; toggles: number; sidebar: Box; main: Box;
};

export async function checks114(js: Js, check: Check): Promise<void> {
  // ---- (a) the gear ----------------------------------------------------------
  const g = await js<Record<string, unknown>>(`(() => {
    const ref = document.createElement('span'); ref.innerHTML = ic('gear');
    const sun = document.createElement('span'); sun.innerHTML = ic('sun');
    const icon = document.querySelector('#sidebar .sb-settings-ic');
    const path = ref.querySelector('path');
    const d = path ? path.getAttribute('d') || '' : '';
    return {row: !!icon && icon.innerHTML === ref.innerHTML, notSun: ref.innerHTML !== sun.innerHTML,
      teeth: (d.match(/A/g) || []).length, closed: /z$/i.test(d.trim()), hub: !!ref.querySelector('circle'),
      size: ref.firstChild ? [ref.firstChild.getAttribute('width'), ref.firstChild.getAttribute('stroke-width')] : null};
  })()`);
  check(
    "T114a: Settings wears a cog — a closed six-tooth outline round a hub, drawn like the other icons, not the sun",
    g["row"] === true && g["notSun"] === true && g["teeth"] === 6 && g["closed"] === true && g["hub"] === true
      && show(g["size"]) === show(["16", "1.75"]),
    show(g),
  );

  // ---- (b) the greeting, 1.3× -----------------------------------------------
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) ?? null;
  const size = w ? (w.getContentSize() as [number, number]) : null;
  const hero = String.raw`(async () => {
    await window.__newSession();
    await new Promise((res) => setTimeout(res, 300));
    const h = document.querySelector('#scroller .emptyhead');
    if (!h) return {err: 'no greeting'};
    const sc = document.querySelector('#scroller').getBoundingClientRect();
    const b = h.getBoundingClientRect(), m = h.querySelector('svg').getBoundingClientRect(), t = h.querySelector('b');
    return {font: getComputedStyle(h).fontSize, mark: Math.round(m.width), markH: Math.round(m.height),
      text: t.textContent, inside: b.left >= sc.left - 0.5 && b.right <= sc.right + 0.5,
      overflow: h.scrollWidth > h.clientWidth + 1};
  })()`;
  try {
    const wide = await js<Record<string, unknown>>(hero);
    check(
      "T114b: the empty chat's greeting is 1.3× — 26px type beside a 39px mark",
      !wide["err"] && wide["font"] === "26px" && wide["mark"] === 39 && wide["markH"] === 39
        && wide["text"] === "What should we work on?" && wide["inside"] === true && wide["overflow"] === false,
      show(wide),
    );
    if (w && size) {
      w.setContentSize(940, 620);
      await wait(500);
      const narrow = await js<Record<string, unknown>>(hero);
      check(
        "T114b: on the narrowest window (940×620) the bigger greeting still fits its column, the mark in proportion",
        !narrow["err"] && narrow["inside"] === true && narrow["overflow"] === false
          && Math.abs(Number(narrow["mark"]) / parseFloat(String(narrow["font"])) - 1.5) < 0.05,
        show(narrow),
      );
    } else {
      process.stdout.write("SKIP T114b narrow: no BrowserWindow to resize in this run\n");
    }
  } finally {
    if (w && size && !w.isDestroyed()) { w.setContentSize(size[0], size[1]); await wait(500); }
  }

  // ---- (c) the sidebar's top row --------------------------------------------
  const before = await js<string>("S.sidebar");
  try {
    if (before !== "open") { await js<unknown>("act('toggle:sidebar')"); await wait(150); }
    const open = await js<Chrome>(CHROME);
    const [s, t] = open.top ? open.top.buttons : [];
    check(
      "T114c: expanded, the sidebar's top row carries Search then the sidebar toggle, and the toolbar carries neither",
      open.expanded && !!open.top && open.top.buttons.length === 2 && s?.act === "palette" && t?.act === "toggle:sidebar"
        && open.toolbar.buttons.length === 0 && open.toolbar.open && open.pill === 0 && open.palettes === 1 && open.toggles === 1,
      show({ top: open.top?.buttons.map((b) => b.act), toolbar: open.toolbar, pill: open.pill, palettes: open.palettes, toggles: open.toggles }),
    );
    check(
      "T114c: the row is the window's title band — the sidebar reaches up over it, #main still starts under it",
      !!open.top && open.sidebar.top <= 0 && open.top.box.top <= 0 && open.top.box.bottom === 52 && open.main.top === 52
        && !!s && !!t && s.box.top >= 6 && t.box.bottom <= 52
        && t.box.right <= open.sidebar.right && t.box.right >= open.sidebar.right - 12 && s.box.right <= t.box.left
        && s.box.left > 90,
      show({ row: open.top?.box, sidebar: open.sidebar, main: open.main, search: s?.box, toggle: t?.box }),
    );
    check(
      "T114c: both are 32px icon buttons a person can reach — named, titled, focusable, on top where they are drawn",
      [s, t].every((b) => !!b && b.box.width === 32 && b.box.height === 32 && b.svg && !!b.aria && b.aria === b.title
        && !b.disabled && b.tab >= 0 && b.hit)
        && /^Search and commands \(/.test(s!.title ?? "") && /^Hide sidebar \(/.test(t!.title ?? ""),
      show([s, t]),
    );
    check(
      "T114c: the toolbar's title starts past the expanded sidebar",
      open.toolbar.titleLeft === null || open.toolbar.titleLeft >= open.sidebar.right,
      show({ titleLeft: open.toolbar.titleLeft, sidebarRight: open.sidebar.right }),
    );
    if (open.electron) {
      check(
        "T114c: the top row drags the window and its buttons do not",
        !!open.top && open.top.region === "drag" && open.top.buttons.every((b) => b.region === "no-drag") && open.toolbar.region === "drag",
        show({ row: open.top?.region, buttons: open.top?.buttons.map((b) => b.region), toolbar: open.toolbar.region }),
      );
    }
    // (d) The inspector toggle stays at the top right and no longer wears the sidebar's glyph.
    const insp = await js<Record<string, unknown>>(`(() => {
      const b = document.querySelector('#toolbar .tb-right [data-act="toggle:inspector"]');
      const side = document.createElement('span'); side.innerHTML = ic('sidebar');
      const tb = document.querySelector('#toolbar').getBoundingClientRect();
      const r = b ? b.getBoundingClientRect() : null;
      return {present: !!b, aria: b ? b.getAttribute('aria-label') : null, title: b ? b.getAttribute('title') : null,
        differs: !!b && !!b.querySelector('svg') && b.querySelector('svg').innerHTML !== side.firstChild.innerHTML,
        rightEnd: !!r && r.left > tb.left + tb.width / 2 && !document.querySelector("#toolbar .tb-right ~ *")};
    })()`);
    check(
      "T114d: the inspector toggle sits at the top right of the main area with its own steps glyph, not the sidebar's",
      insp["present"] === true && insp["differs"] === true && insp["rightEnd"] === true
        && typeof insp["aria"] === "string" && insp["aria"] === insp["title"] && /steps and reasoning/.test(String(insp["aria"])),
      show(insp),
    );
    // A real click on the magnifier opens the same palette the pill did; so does the chord.
    const clicked = await js<{ overlay: string | null; chord: string | null }>(`(() => {
      const b = document.querySelector('#sidebar .sb-top [data-act="palette"]');
      if (b) b.click();
      const overlay = S.overlay; act('close');
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', code: 'KeyK', metaKey: IS_MAC, ctrlKey: !IS_MAC, bubbles: true, cancelable: true}));
      const chord = S.overlay; act('close');
      return {overlay, chord};
    })()`);
    check(
      "T114c: the magnifier opens Search and commands, and ⌘ K still does",
      clicked.overlay === "palette" && clicked.chord === "palette",
      show(clicked),
    );

    // Collapsed: back in the toolbar, next to the traffic lights.
    await js<unknown>("act('toggle:sidebar')");
    await wait(150);
    const rail = await js<Chrome>(CHROME);
    const [rt, rs] = rail.toolbar.buttons;
    check(
      "T114c: collapsed, the toggle and Search stand in the toolbar next to the lights, and the rail has no top row",
      rail.state === "rail" && !rail.expanded && rail.top === null && !rail.toolbar.open
        && rail.toolbar.buttons.length === 2 && rt?.act === "toggle:sidebar" && rs?.act === "palette"
        && rt.box.right <= rs.box.left && rt.hit && rs.hit && rail.sidebar.top === 52 && rail.sidebar.width === 52
        && (!rail.electron || !rail.darwin || rt.box.left >= 90) && rail.palettes === 1 && rail.toggles === 1,
      show({ state: rail.state, top: rail.top, toolbar: rail.toolbar, sidebar: rail.sidebar }),
    );
  } finally {
    const now = await js<string>("S.sidebar");
    if (now !== before) await js<unknown>("act('toggle:sidebar')");
    await wait(100);
  }
}
