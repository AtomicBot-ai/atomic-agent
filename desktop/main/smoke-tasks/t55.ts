/**
 * Release-fix checks for backlog items 55, 56 and 57 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=55,56,57`.
 *
 * Danya's 02.10 review of the composer, in three parts:
 * 55 (ATO-167) — the mode and model popovers had a Done that did nothing a
 *     person could see; "Download more models…" sat under a long list and the
 *     models this Mac cannot run sat above it. No Done; Download first; the
 *     out-of-reach names at the very bottom.
 * 56 (ATO-168) — a "+" mini mark under a reply, and copy flying off to the
 *     right. Valera's call: a dot under the LAST reply only, pulsing while it
 *     is written; the reply's actions start at its left, after the dot.
 * 57 (ATO-166) — the empty chat repeated the model under the greeting;
 *     Settings had a house; the context gauge read as a clock. The model line
 *     goes, Settings gets a gear, the gauge is a donut.
 * The window's own state is staged and put back; nothing is written.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checks55(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(async () => {
    const keep = {open: SEL.open, kind: SEL.kind, overlay: S.overlay};
    try {
      openSelector('model');
      await new Promise((res) => setTimeout(res, 300));
      const pop = document.querySelector('#overlays .selpop');
      const rows = pop ? [...pop.querySelectorAll('.sellist > .modelrow, .sellist > .selouth, .sellist > .selout')] : [];
      const ids = rows.map((n) => n.classList.contains('modelrow') ? (n.dataset.id || '?') : n.classList.contains('selouth') ? '#out-head' : '#out');
      const model = {pop: !!pop, done: pop ? pop.querySelectorAll('[data-act="close"]').length : null, ids,
        backend: selBackend()};
      act('close');
      S.overlay = 'modes'; render();
      const mp = document.querySelector('.popover');
      const modes = {pop: !!mp, done: mp ? mp.querySelectorAll('[data-act="close"]').length : null};
      return {model, modes};
    } finally { S.overlay = keep.overlay; SEL.open = keep.open; SEL.kind = keep.kind; render(); }
  })()`);
  const model = (r["model"] ?? {}) as { pop?: boolean; done?: number; ids?: string[]; backend?: string };
  const modes = (r["modes"] ?? {}) as { pop?: boolean; done?: number };
  check("T55: the model popover has no Done", model.pop === true && model.done === 0, show(model));
  check("T55: the mode popover has no Done", modes.pop === true && modes.done === 0, show(modes));
  const ids = model.ids ?? [];
  const dl = ids.indexOf("downloadMore");
  const outAt = ids.indexOf("#out-head");
  const lastModel = Math.max(...ids.map((x, i) => (x.startsWith("#") || x === "downloadMore" ? -1 : i)));
  check(
    "T55: on the local route, Download more models… is the first row and the models this Mac cannot run come after every model",
    model.backend !== "local" ? true : dl === 0 && (outAt < 0 || outAt > lastModel),
    model.backend !== "local" ? `not on the local route (${model.backend}): the ordering is the local list's` : show(ids),
  );
}

export async function checks56(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(async () => {
    const keep = {log: S.log, busy: S.busy, stream: S.streamId, room: S.room, settings: S.settings};
    try {
      S.settings = null; S.room = 'chat'; S.busy = false; S.streamId = null;
      const a1 = nid(), a2 = nid();
      S.log = [{id: nid(), k: 'user', text: 'smoke t56: first'}, {id: a1, k: 'assistant', text: 'smoke t56: reply one'},
               {id: nid(), k: 'user', text: 'smoke t56: second'}, {id: a2, k: 'assistant', text: 'smoke t56: reply two'}];
      render(); await new Promise((res) => setTimeout(res, 80));
      const dots = [...document.querySelectorAll('#content .enddot')];
      const holder = dots[0] && dots[0].closest('.turn');
      const prose = holder && holder.querySelector('.tk-asst > .prose');
      const btn = holder && holder.querySelector('.msgacts .msgact');
      const rest = {count: dots.length, onLast: !!(holder && prose && prose.textContent.includes('reply two')),
        live: !!(dots[0] && dots[0].classList.contains('live')),
        btnLeft: btn ? Math.round(btn.getBoundingClientRect().left) : null, proseLeft: prose ? Math.round(prose.getBoundingClientRect().left) : null,
        dotVisible: dots[0] ? getComputedStyle(dots[0], '::before').backgroundColor !== 'rgba(0, 0, 0, 0)' : false};
      S.busy = true; S.streamId = a2; render(); await new Promise((res) => setTimeout(res, 50));
      const live = document.querySelector('#content .enddot');
      const writing = {count: document.querySelectorAll('#content .enddot').length, live: !!(live && live.classList.contains('live'))};
      return {rest, writing};
    } finally { Object.assign(S, {log: keep.log, busy: keep.busy, streamId: keep.stream, room: keep.room, settings: keep.settings}); render(); }
  })()`);
  const rest = (r["rest"] ?? {}) as Record<string, unknown>;
  const writing = (r["writing"] ?? {}) as Record<string, unknown>;
  check(
    "T56: one dot, under the last reply only, at rest when the turn is done",
    rest["count"] === 1 && rest["onLast"] === true && rest["live"] === false && rest["dotVisible"] === true,
    show(rest),
  );
  check(
    "T56: the reply's copy button starts at its left, just after the dot",
    typeof rest["btnLeft"] === "number" && typeof rest["proseLeft"] === "number"
      && Math.abs(Number(rest["btnLeft"]) - (Number(rest["proseLeft"]) + 20)) <= 1,
    show(rest),
  );
  check("T56: while the last reply is being written, its dot pulses", writing["count"] === 1 && writing["live"] === true, show(writing));
  await tick(30);
}

export async function checks57(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const plate = document.createElement('div'); plate.innerHTML = emptyPlateHTML();
    const gearRef = document.createElement('span'); gearRef.innerHTML = ic('gear');
    const icon = document.querySelector('#sidebar .sb-settings-ic');
    const saved = {tokens: CTX.tokens, window: CTX.window, source: CTX.source};
    let ring = null;
    try {
      CTX.tokens = 30000; CTX.window = 100000; CTX.source = 'built';
      const host = document.createElement('div'); host.className = 'cfoot'; host.innerHTML = contextChip(); document.body.appendChild(host);
      const fg = host.querySelector('.ctxring .fg'), bg = host.querySelector('.ctxring .bg');
      ring = {sameR: !!fg && !!bg && fg.getAttribute('r') === bg.getAttribute('r'), bgFill: bg ? getComputedStyle(bg).fill : null,
        dash: fg ? fg.getAttribute('stroke-dasharray') : null};
      host.remove();
    } finally { Object.assign(CTX, saved); }
    return {metaItems: plate.querySelectorAll('.emptymeta .em-it').length, sep: plate.querySelectorAll('.em-sep').length,
      wd: !!plate.querySelector('.em-wd'), workingDir: !!workingDir(),
      gear: !!icon && icon.innerHTML === gearRef.innerHTML, ring};
  })()`);
  check(
    "T57: the line under the empty chat's greeting no longer repeats the model — the folder alone",
    r["sep"] === 0 && (r["workingDir"] ? r["metaItems"] === 1 && r["wd"] === true : r["metaItems"] === 0),
    show(r),
  );
  check("T57: Settings in the sidebar wears a gear, not a house", r["gear"] === true, show(r["gear"]));
  const ring = (r["ring"] ?? {}) as Record<string, unknown>;
  check(
    "T57: the context gauge is a donut — an arc on a full track of the same radius, no fill — 30% drawn as 30% of the ring",
    ring["sameR"] === true && ring["bgFill"] === "none" && String(ring["dash"]).startsWith("14.14 "),
    show(ring),
  );
}
