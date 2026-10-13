/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=165`.
 *
 * ATO-165: the sidebar's chat list.
 * (a) Every chat row carries one "…" control (it replaced the separate pin and
 *     mark-as-unread controls). It opens a menu drawn in the window — Pin or
 *     Unpin, Mark as read or Mark as unread, then Delete… under a rule — and
 *     a right-click on the row opens the same menu at the pointer. Neither
 *     opens the chat. The menu is keyboard-driven: Enter on the "…" opens it
 *     with the first row focused, the arrows move, Escape closes it and gives
 *     the focus back to the "…".
 * (b) A "Pinned" section above Chats while anything is pinned, the last pinned
 *     on top, and the pinned chats are not repeated under Chats.
 * (c) Delete… asks first; deleting the open chat leaves a new, empty one.
 *     Driven on a stand-in row this check adds itself (the agent answers 200
 *     to a DELETE of an id it does not hold), never on a real chat.
 *
 * Pins, read stamps and the open chat are put back; nothing of the operator's
 * is deleted.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* The open menu as drawn, or null. */
const MENU = String.raw`(() => {
  const m = document.querySelector('#overlays .sesmenu');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return {role: m.getAttribute('role'), overlay: S.overlay, id: SESMENU.id,
    verbs: [...m.querySelectorAll('[role="menuitem"]')].map((n) => n.dataset.verb),
    labels: [...m.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent.trim()),
    sepBeforeDelete: !!m.querySelector('.sesmenu-sep + [data-verb="delask"]'),
    danger: [...m.querySelectorAll('.tk-mi--danger')].map((n) => n.dataset.verb),
    focused: document.activeElement && m.contains(document.activeElement) ? document.activeElement.dataset.verb : null,
    box: {left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom)},
    win: {w: window.innerWidth, h: window.innerHeight}};
})()`;

type Menu = {
  role: string | null; overlay: string | null; id: string | null; verbs: string[]; labels: string[];
  sepBeforeDelete: boolean; danger: string[]; focused: string | null;
  box: { left: number; top: number; right: number; bottom: number }; win: { w: number; h: number };
} | null;

const sel = (id: string) => `'.sesrow[data-ses="' + CSS.escape(${show(id)}) + '"]'`;

export async function checks165(js: Js, check: Check): Promise<void> {
  const keep = await js<{ pinned: string[]; seen: Record<string, number>; open: string; sidebar: string }>(
    "({pinned: PREFS.pinned.slice(), seen: Object.assign({}, PREFS.seen), open: S.sessionId, sidebar: S.sidebar})",
  );
  try {
    if (keep.sidebar !== "open") { await js<unknown>("act('toggle:sidebar')"); await wait(150); }
    await js<number>("window.__sessionsRefresh()");
    const chats = await js<Array<{ id: string }>>("window.__sidebar().chats.map((c) => ({id: c.id}))");
    if (chats.length < 2) {
      process.stdout.write(`SKIP T165 a/b: ${chats.length} chat(s) in this workspace, two are needed\n`);
    } else {
      // Two chats that are not the open one, so a fall-through to the row would show.
      const pick = [...new Map(chats.filter((c) => c.id !== keep.open).concat(chats).map((c) => [c.id, c] as const)).values()];
      const a = pick[0]!, b = pick[1]!;

      // ---- (a) the "…" and its menu -----------------------------------------
      const row = await js<{ tail: string[]; aria: string | null; tab: number; haspopup: string | null; svg: boolean } | null>(`(() => {
        const r = document.querySelector(${sel(a.id)});
        if (!r) return null;
        const m = r.querySelector('[data-sesmenu]');
        return {tail: [...r.children].slice(2).map((c) => (c.className || '').split(' ')[0]),
          aria: m && m.getAttribute('aria-label'), tab: m ? m.tabIndex : -1,
          haspopup: m && m.getAttribute('aria-haspopup'), svg: !!(m && m.querySelector('svg'))};
      })()`);
      check(
        "T165a: a chat row carries one \"…\" control — named, focusable, a menu button — and no separate pin or unread control",
        !!row && show(row.tail) === show(["sesmore"]) && row.aria === "Chat actions" && row.tab === 0
          && row.haspopup === "menu" && row.svg,
        show(row),
      );

      const opened = await js<{ menu: Menu; sessionId: string; expanded: string | null }>(`(() => {
        const before = S.sessionId;
        document.querySelector(${sel(a.id)} + ' [data-sesmenu]').click();
        const ctl = document.querySelector(${sel(a.id)} + ' [data-sesmenu]');
        return {menu: ${MENU}, sessionId: S.sessionId === before ? 'same' : S.sessionId, expanded: ctl && ctl.getAttribute('aria-expanded')};
      })()`);
      const m = opened.menu;
      check(
        "T165a: the \"…\" opens the row menu — Pin/Unpin, Mark as read/unread, then Delete… under a rule — without opening the chat",
        !!m && m.role === "menu" && m.overlay === "sesmenu" && m.id === a.id && m.verbs.length === 3
          && ["pin", "unpin"].includes(m.verbs[0]) && ["read", "unread"].includes(m.verbs[1]) && m.verbs[2] === "delask"
          && m.labels[2] === "Delete…" && m.sepBeforeDelete && show(m.danger) === show(["delask"])
          && !m.labels.some((l) => /rename/i.test(l))
          && opened.sessionId === "same" && opened.expanded === "true",
        show(opened),
      );
      check(
        "T165a: it opens with its first row focused, inside the window",
        !!m && m.focused === m.verbs[0] && m.box.left >= 0 && m.box.top >= 0 && m.box.right <= m.win.w && m.box.bottom <= m.win.h,
        show(m),
      );
      const keys = await js<{ down: string | null; up: string | null; end: string | null; afterEsc: string | null; focusBack: boolean }>(`(() => {
        const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true}));
        const f = () => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.verb || null : null;
        key('ArrowDown'); const down = f();
        key('ArrowUp'); const up = f();
        key('End'); const end = f();
        key('Escape');
        const ctl = document.querySelector(${sel(a.id)} + ' [data-sesmenu]');
        return {down, up, end, afterEsc: S.overlay, focusBack: document.activeElement === ctl};
      })()`);
      check(
        "T165a: the arrows and End move through the menu; Escape closes it and gives the focus back to the \"…\"",
        !!m && keys.down === m.verbs[1] && keys.up === m.verbs[0] && keys.end === "delask"
          && keys.afterEsc === null && keys.focusBack,
        show(keys),
      );
      const enter = await js<{ overlay: string | null; id: string | null; focused: string | null }>(`(() => {
        const ctl = document.querySelector(${sel(a.id)} + ' [data-sesmenu]');
        ctl.focus();
        ctl.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
        const out = {overlay: S.overlay, id: SESMENU.id,
          focused: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.verb || null : null};
        act('close');
        return out;
      })()`);
      check(
        "T165a: Enter on a focused \"…\" opens the same menu from the keyboard",
        enter.overlay === "sesmenu" && enter.id === a.id && !!enter.focused,
        show(enter),
      );
      const right = await js<{ menu: Menu; sessionId: string; x: number; y: number }>(`(() => {
        const before = S.sessionId;
        const r = document.querySelector(${sel(a.id)});
        const b = r.getBoundingClientRect();
        const x = Math.round(b.left + 40), y = Math.round(b.top + b.height / 2);
        r.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: x, clientY: y}));
        const out = {menu: ${MENU}, sessionId: S.sessionId === before ? 'same' : S.sessionId, x, y};
        act('close');
        return out;
      })()`);
      const rm = right.menu;
      check(
        "T165a: a right-click on the row opens the same menu at the pointer, without opening the chat",
        !!rm && !!m && show(rm.verbs) === show(m.verbs) && rm.id === a.id && right.sessionId === "same"
          && Math.abs(rm.box.left - right.x) <= 1
          // below the pointer, or above it when the window has no room underneath
          && (Math.abs(rm.box.top - right.y) <= 1 || Math.abs(rm.box.bottom - right.y) <= 12),
        show(right),
      );
      // Read and unread through the menu: each pick closes it and flips the item's word.
      const flip = await js<{ first: string | null; second: string | null; closed: boolean }>(`(() => {
        const open = () => document.querySelector(${sel(a.id)} + ' [data-sesmenu]').click();
        const item = () => document.querySelector('.sesmenu [data-verb="read"], .sesmenu [data-verb="unread"]');
        open(); const i1 = item(); const first = i1 && i1.dataset.verb; i1.click();
        const closed = S.overlay !== 'sesmenu';
        open(); const i2 = item(); const second = i2 && i2.dataset.verb; act('close');
        return {first, second, closed};
      })()`);
      check(
        "T165a: Mark as read and Mark as unread take turns, and a pick closes the menu",
        !!flip.first && !!flip.second && flip.first !== flip.second && flip.closed,
        show(flip),
      );

      // ---- (b) the Pinned section -------------------------------------------
      await js<unknown>(`(() => { PREFS.pinned = PREFS.pinned.filter((x) => x !== ${show(a.id)} && x !== ${show(b.id)}); savePrefs(); render(); })()`);
      await js<unknown>(`act('pin:' + ${show(a.id)})`);
      await js<unknown>(`act('pin:' + ${show(b.id)})`);
      const pinnedView = await js<{ headers: string[]; pinned: string[]; chats: string[] }>(`(() => ({
        headers: window.__sidebar().headers,
        pinned: [...document.querySelectorAll('#sidebar [data-list="pinned"] .sesrow')].map((n) => n.dataset.ses),
        chats: [...document.querySelectorAll('#sidebar [data-list="chats"] .sesrow')].map((n) => n.dataset.ses),
      }))()`);
      check(
        "T165b: a Pinned section above Chats, the last pinned on top, and its chats not repeated under Chats",
        pinnedView.headers[0] === "Pinned" && pinnedView.headers[1] === "Chats"
          && pinnedView.pinned[0] === b.id && pinnedView.pinned[1] === a.id
          && !pinnedView.chats.includes(a.id) && !pinnedView.chats.includes(b.id),
        show(pinnedView),
      );
      await js<unknown>(`act('unpin:' + ${show(a.id)})`);
      await js<unknown>(`act('unpin:' + ${show(b.id)})`);
      const unpinnedView = await js<{ headers: string[]; section: boolean; inChats: boolean }>(`(() => ({
        headers: window.__sidebar().headers,
        section: !!document.querySelector('#sidebar [data-list="pinned"]'),
        inChats: !!document.querySelector('#sidebar [data-list="chats"] ' + ${sel(a.id)}),
      }))()`);
      check(
        "T165b: with nothing pinned the section is gone and the chat is back under Chats",
        (keep.pinned.length > 0 || (!unpinnedView.section && unpinnedView.headers[0] === "Chats")) && unpinnedView.inChats,
        show(unpinnedView) + (keep.pinned.length > 0 ? " (the operator has pins of their own; only the row's return is asserted)" : ""),
      );
    }

    // ---- (c) Delete… asks, and deleting the open chat leaves an empty one ---
    const probe = `smoke-ato165-${Date.now().toString(16)}`;
    const asked = await js<{ alert: string | null; menu: boolean; title: string | null }>(`(() => {
      SESSIONS.unshift({id: ${show(probe)}, t: 'ATO-165 probe', updatedAt: Date.now(), status: 'done'});
      act('pin:' + ${show(probe)});
      S.sessionId = ${show(probe)};
      render();
      document.querySelector(${sel(probe)} + ' [data-sesmenu]').click();
      document.querySelector('.sesmenu [data-verb="delask"]').click();
      return {alert: S.alert ? S.alert.act : null, menu: S.overlay === 'sesmenu', title: S.alert ? S.alert.title : null};
    })()`);
    check(
      "T165c: Delete… asks first — the confirm names the chat, the menu is gone",
      asked.alert === `del:${probe}` && !asked.menu && /ATO-165 probe/.test(asked.title ?? ""),
      show(asked),
    );
    await js<unknown>(`(() => { const b = document.querySelector('.alertbox [data-act="del:' + ${show(probe)} + '"]'); if (b) b.click(); })()`);
    type Gone = { row: boolean; sessionId: string; log: number; pinned: boolean; alert: boolean; focusEntry: boolean };
    let gone: Gone | null = null;
    for (let i = 0; i < 20; i++) {
      await wait(250);
      gone = await js<Gone | null>(`(() => ({row: SESSIONS.some((s) => s.id === ${show(probe)}), sessionId: S.sessionId,
        log: S.log.length, pinned: PREFS.pinned.includes(${show(probe)}), alert: !!S.alert,
        focusEntry: document.activeElement && document.activeElement.id === 'entry'}))()`);
      if (gone && !gone.row) break;
    }
    check(
      "T165c: deleting the open chat removes it, its pin, and leaves a new empty chat with the caret in the composer",
      !!gone && !gone.row && gone.sessionId === "" && gone.log === 0 && !gone.pinned && !gone.alert && gone.focusEntry,
      show(gone),
    );
  } finally {
    await js<unknown>(`(() => {
      if (S.overlay === 'sesmenu' || S.alert) act('close');
      const i = SESSIONS.findIndex((s) => String(s.id).indexOf('smoke-ato165-') === 0);
      if (i >= 0) SESSIONS.splice(i, 1);
      PREFS.pinned = ${show(keep.pinned)}; PREFS.seen = ${show(keep.seen)}; savePrefs(); render();
    })()`);
    if (keep.open) { await js<unknown>(`window.__openSession(${show(keep.open)})`); await wait(800); }
    const now = await js<string>("S.sidebar");
    if (now !== keep.sidebar) await js<unknown>("act('toggle:sidebar')");
  }
}
