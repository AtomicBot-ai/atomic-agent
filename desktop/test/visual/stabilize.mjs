/**
 * stabilize.mjs: make two shots of the same screen come out byte-alike.
 *
 * Everything that moves on its own is pinned before a shot: CSS animations,
 * transitions and the text caret (injected stylesheet), the clock (Date
 * frozen, timezone and locale fixed), motion (prefers-reduced-motion), the
 * pointer (parked in a corner) and the app version (any x.y.z in visible
 * text reads 0.0.0). Model replies are never live: screens.mjs pushes fixed
 * text. Fonts are awaited with the same check visual.drive.mjs makes.
 *
 * These run in the page through Runtime.evaluate. Unlike drive.mjs's rule
 * (look, never act), the visual suite writes a stylesheet and a Date shim
 * into the page on purpose: it is a camera, not a user, and none of it
 * changes what a click would do.
 */

/** The fixed moment every shot lives in: 27 Nov 2026, 12:00 UTC. */
export const FROZEN_TIME = Date.UTC(2026, 10, 27, 12, 0, 0);

export const STABLE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;

/** Add (or keep) the stylesheet above. Survives the app's innerHTML repaints: it lives in <head>. */
export function injectCssExpr(css = STABLE_CSS) {
  return `(() => {
    let s = document.getElementById('visual-stable-css');
    if (!s) { s = document.createElement('style'); s.id = 'visual-stable-css'; document.head.appendChild(s); }
    s.textContent = ${JSON.stringify(css)};
    return true;
  })()`;
}

/**
 * Freeze Date at `t`. A Proxy rather than a subclass: `Date()` called
 * without new must still return a string, `instanceof Date` must still hold.
 */
export function freezeDateExpr(t = FROZEN_TIME) {
  return `(() => {
    if (window.__visualFrozenAt === ${t}) return true;
    const Real = window.__visualRealDate || Date;
    window.__visualRealDate = Real;
    const T = ${t};
    window.Date = new Proxy(Real, {
      construct(target, args, nt) { return Reflect.construct(target, args.length ? args : [T], nt); },
      apply() { return new Real(T).toString(); },
      get(target, p, r) { return p === 'now' ? () => T : Reflect.get(target, p, r); },
    });
    window.__visualFrozenAt = T;
    return true;
  })()`;
}

/** A version-shaped token: 0.0.11, v0.10.0, 1.2.3-beta.1. */
export const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/g;

/** Pure: the text with every version token replaced by 0.0.0 (keeps a leading v). */
export function scrubVersions(text) {
  return String(text).replace(VERSION_RE, (m) => (m.startsWith('v') ? 'v0.0.0' : '0.0.0'));
}

/**
 * Rewrite version tokens in visible text nodes, just before a shot. Inputs
 * and textareas are left alone (their value is the user's).
 */
export function scrubVersionsExpr() {
  return `(() => {
    const re = ${VERSION_RE.toString()};
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, hits = 0;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,textarea,input')) continue;
      const v = n.nodeValue;
      re.lastIndex = 0;
      if (!re.test(v)) continue;
      re.lastIndex = 0;
      n.nodeValue = v.replace(re, (m) => (m.startsWith('v') ? 'v0.0.0' : '0.0.0'));
      hits++;
    }
    return hits;
  })()`;
}

/**
 * The font check from visual.drive.mjs, verbatim in what it asks: Figtree
 * for Latin, Inter for Cyrillic, DM Mono for code. Copied rather than
 * imported because visual.drive.mjs is a script that launches the app on
 * import.
 */
export const FONTS_EXPR = `(async () => {
  await document.fonts.ready;
  await Promise.allSettled([
    document.fonts.load('600 34px Figtree', 'Atomic'),
    document.fonts.load('600 34px Inter', '\\u0416\\u0438\\u0437\\u043D\\u044C'),
    document.fonts.load('400 13px "DM Mono"', 'atag'),
  ]);
  return {
    figtree: document.fonts.check('600 34px Figtree', 'Atomic'),
    inter: document.fonts.check('600 34px Inter', '\\u0416\\u0438\\u0437\\u043D\\u044C'),
    mono: document.fonts.check('400 13px "DM Mono"', 'atag'),
  };
})()`;

/** Two animation frames: whatever render() queued has painted. Capped at
    1 s, since a window the OS considers hidden may not run frames at all. */
export const TWO_FRAMES_EXPR = 'new Promise((r) => { setTimeout(() => r(false), 1000); requestAnimationFrame(() => requestAnimationFrame(() => r(true))); })';

/** A cheap fingerprint of what is on screen, for waitQuiet. */
export const SCREEN_KEY_EXPR = `(() => {
  const t = document.body ? document.body.innerText : '';
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return t.length + ':' + h + ':' + document.querySelectorAll('*').length;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Once per launch: timezone, locale, reduced motion, frozen clock, the
 * stylesheet. Each CDP call is allowed to fail on an older Chromium.
 */
export async function pinPage(app) {
  const soft = (p) => p.catch(() => null);
  await soft(app.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }));
  await soft(app.send('Emulation.setLocaleOverride', { locale: 'en-US' }));
  await soft(app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }));
  await app.eval(freezeDateExpr());
  await app.eval(injectCssExpr());
}

/** The window size and scale for one variant. */
export async function setViewport(app, v) {
  await app.send('Emulation.setDeviceMetricsOverride', {
    width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: false,
  });
  await sleep(300);
}

/** Wait until the visible text and node count stop changing for `quietMs`. */
export async function waitQuiet(app, { quietMs = 800, timeout = 8000 } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  let since = Date.now();
  while (Date.now() < until) {
    const k = await app.eval(SCREEN_KEY_EXPR).catch(() => null);
    if (k !== last) { last = k; since = Date.now(); } else if (Date.now() - since >= quietMs) return true;
    await sleep(150);
  }
  return false;
}

/** Everything a shot needs right before the capture. `quick` skips the
    quiet wait, for a screen that would leave by itself while it waits. */
export async function readyForShot(app, v, { quick = false } = {}) {
  await app.eval(injectCssExpr());
  /* The pointer goes to the bottom-right corner, away from the sidebar,
     the toolbar and the composer, so no hover state is in the picture. */
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: v.width - 2, y: v.height - 2, button: 'none' });
  if (!quick) await waitQuiet(app);
  await app.eval(scrubVersionsExpr());
  await app.eval(TWO_FRAMES_EXPR);
}
