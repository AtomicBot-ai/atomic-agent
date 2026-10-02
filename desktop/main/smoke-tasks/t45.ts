/**
 * Release-fix checks for desktop item 45 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=45`.
 *
 * 45 — the first-run wizard, from Danya's review (01.10, «P1 → Онбординг»):
 *   Д1  the first step spoke of the app in the third person ("Choose how
 *       Atomic Agent gets its model") and said "You can add the others later";
 *   Д3  the rail's "01 Setup / 02 Data" were pills, the current one filled,
 *       and read as buttons that did nothing;
 *   Д4  the cards stopped at 640–720px while the action bar ran the column,
 *       so they ended short of Continue;
 *   Д5  the model step said "after one download" again, right after the card
 *       that brought you there said it;
 *   Д6  a model with no mark ("Meta Muse Glimmer 30B") wore a small grey glyph
 *       that read as a logo that failed to load, and a file that did not load
 *       drew a broken image;
 *   Д7  badges that do nothing ("Recommended") were pills, like buttons;
 *   Д8  a third line ("A small model…", "Tight fit on 18 GB…") on some cards
 *       made the cards two heights;
 *   Д9  the name and the facts under it were one weight apart;
 *   Д10 the "Needs more memory than this Mac has" block ran on under the list;
 *   Д11 "Add a model from Hugging Face…" was a bare row lost under the list.
 *
 * Everything runs on the renderer's own functions, through the wizard's test
 * jump (`__obOpen`) with the local list's catalogue and the RAM figure seeded
 * here, so no `models list` runs and no stamp is written. The geometry is
 * measured on the real layer, made wider than its column for the moment of a
 * measurement so the right edge has room to be wrong. What the check seeded
 * is put back, and the wizard is closed.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const q = (v: unknown) => JSON.stringify(v);

/* The local list at 18 GB: a best fit, a small model, reduced-refusal weights,
   a tight fit, and two that will not run (one of them the model with no mark). */
const MODELS = [
  { id: "qwen-smoke-t45-best", name: "Smoke Best 9B GGUF", description: "Balanced performance", size: "6.2 GB", sizeGb: 6.2, minRamGb: 8, recommendedRamGb: 16, downloaded: false },
  { id: "qwen-smoke-t45-small", name: "Smoke Small 4B GGUF", description: "Quality-size sweet spot", size: "3.4 GB", sizeGb: 3.4, minRamGb: 6, recommendedRamGb: 8, downloaded: false },
  { id: "qwen-smoke-t45-unc", name: "Smoke Unc 9B GGUF", description: "Reduced-refusal Smoke 9B (abliterated)", size: "6 GB", sizeGb: 6, minRamGb: 8, recommendedRamGb: 12, downloaded: false, uncensored: true, tag: "Use at your own risk" },
  { id: "gemma-smoke-t45-tight", name: "Smoke Tight 26B GGUF", description: "Fast MoE with 256K context (QAT)", size: "15.4 GB", sizeGb: 15.4, minRamGb: 16, recommendedRamGb: 24, downloaded: false },
  { id: "qwen-smoke-t45-over", name: "Smoke Over 35B GGUF", description: "High quality reasoning", size: "22 GB", sizeGb: 22, minRamGb: 24, recommendedRamGb: 36, downloaded: false },
  { id: "muse-glimmer-30b", name: "Meta Muse Glimmer 30B GGUF", description: "Multimodal 30B MoE, generic tool calling", size: "18.6 GB", sizeGb: 18.6, minRamGb: 20, recommendedRamGb: 32, downloaded: false },
];

/* Page helpers, installed for the run and removed after it: a colour's
   contrast, and the layer widened before a measurement (every render
   rebuilds #onboarding, so it is widened again after each one). */
const HELPERS = `(() => {
  const rgb = (s) => {
    const n = (String(s).match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    return /^color\\(/.test(String(s)) ? n.map((x) => x * 255) : n;
  };
  const lum = (c) => {
    const [r, g, b] = rgb(c).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  window.__t45 = {
    contrast: (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, s) => s - p); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; },
    widen: () => { const root = document.getElementById('onboarding'); if (root) root.style.width = '1600px'; return root; },
    right: (n) => (n ? Math.round(n.getBoundingClientRect().right) : null),
  };
  return true;
})()`;

export async function checks45(js: Js, check: Check): Promise<void> {
  // A build without the fix lacks some of these names: that is a FAIL with its reason, not a dead suite.
  const run = async (code: string): Promise<Record<string, unknown>> => {
    try {
      return (await js<Record<string, unknown> | null>(code)) ?? {};
    } catch (e) {
      return { err: e instanceof Error ? e.message : String(e) };
    }
  };

  await run(`(() => {
    window.__t45saved = {models: OB.models, ram: OB.ram, outOpen: OB.outOpen,
      wiz: {phase: WIZ.phase, row: WIZ.row, q: WIZ.q, cur: WIZ.cur}};
    return true;
  })()`);
  await run(HELPERS);
  try {
    await firstStep(run, check);
    await rightEdge(run, check);
    await modelStep(run, check);
    await outOfReach(run, check);
    await marks(run, check);
    await badges(run, check);
  } finally {
    await run(`(() => {
      const s = window.__t45saved;
      if (s) { OB.models = s.models; OB.ram = s.ram; OB.outOpen = s.outOpen; Object.assign(WIZ, s.wiz); }
      delete window.__t45saved; delete window.__t45;
      window.__obClose();
      return true;
    })()`);
  }
}

type Run = (code: string) => Promise<Record<string, unknown>>;

/* Д1, Д3 — the first step's words, and the rail's phases. */
async function firstStep(run: Run, check: Check): Promise<void> {
  const r = await run(`(() => {
    window.__obOpen('choose');
    const root = document.getElementById('onboarding');
    const on = root.querySelector('.ob-rail .ob-stepmark.on');
    const cs = on ? getComputedStyle(on) : null;
    const list = root.querySelector('.ob-rail .ob-stepmarks');
    return {
      title: ((root.querySelector('.ob-title') || {}).textContent || '').trim(),
      explain: ((root.querySelector('.ob-body > .ob-explain') || {}).textContent || '').trim(),
      oldWords: /gets its model|the others later/.test(root.textContent || ''),
      list: list ? list.tagName : null,
      tags: [...root.querySelectorAll('.ob-rail .ob-stepmark')].map((n) => n.tagName),
      current: on ? on.getAttribute('aria-current') : null,
      onText: on ? (on.textContent || '').trim() : null,
      background: cs ? cs.backgroundColor : null,
      radius: cs ? cs.borderTopLeftRadius : null,
      cursor: cs ? cs.cursor : null,
      controls: root.querySelectorAll('.ob-rail button, .ob-rail a, .ob-rail [tabindex]').length,
    };
  })()`);
  check(
    "T45: the first step asks where your model should run, and says what can be added later, and where",
    r.title === "Where should your model run?" && r.explain === "You can add cloud or custom models later in Settings."
      && r.oldWords === false,
    q(r),
  );
  check(
    "T45: the rail's 01 Setup / 02 Data is a progress list, not two buttons — no pill, no fill, nothing to press",
    r.list === "OL" && q(r.tags) === q(["LI", "LI"]) && r.current === "step" && /01/.test(String(r.onText))
      && r.background === "rgba(0, 0, 0, 0)" && r.radius === "0px" && r.cursor === "default" && r.controls === 0,
    q(r),
  );
}

/* Д4 — on every kind of step, the cards and the action bar share one right
   edge. The layer is made wider than its column first, so a card that stops
   short of the bar shows. */
async function rightEdge(run: Run, check: Check): Promise<void> {
  const r = await run(`(() => {
    const out = {};
    const measure = (key, cards, primary) => {
      const root = window.__t45.widen();
      const col = root && root.querySelector('.ob');
      const cs = col ? getComputedStyle(col) : null;
      out[key] = {
        column: col ? Math.round(col.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) : 0,
        bar: window.__t45.right(root && root.querySelector(primary)),
        cards: root ? [...root.querySelectorAll(cards)].map(window.__t45.right) : [],
      };
    };
    OB.models = ${q(MODELS)}; OB.ram = 18; OB.outOpen = null;
    window.__obOpen('choose');
    measure('choose', '.ob-routes .ob-row', '.ob > .ob-foot .btn-p');
    window.__obOpen('local_pick', {stamped: ['localSetupSeenAt']});
    measure('local', '.ob-models, .ob-hfrow', '.ob > .ob-foot .btn-p');
    window.__obOpen('custom_chat_url');
    measure('url', '.ob-field', '.ob > .ob-foot .btn-p');
    window.__obOpen('cloud'); window.__wizPhase('pick_kind');
    measure('cloud', '.ob-wizlist .prows', '.ob-wiz > .ob-foot .btn-p');
    return out;
  })()`);
  const steps = ["choose", "local", "url", "cloud"];
  const flush = steps.every((k) => {
    const s = r[k] as { column?: number; bar?: number | null; cards?: number[] } | undefined;
    return !!s && typeof s.bar === "number" && (s.column ?? 0) > 760 && (s.cards ?? []).length > 0
      && (s.cards ?? []).every((x) => Math.abs(x - (s.bar as number)) <= 1);
  });
  check(
    "T45: the cards end where the action bar ends — one right edge on the route, model, endpoint and provider steps",
    flush,
    q(r),
  );
}

/* Д5, Д7 (the onboarding's own badge), Д8, Д9, Д11 — the model step. */
async function modelStep(run: Run, check: Check): Promise<void> {
  const r = await run(`(() => {
    OB.models = ${q(MODELS)}; OB.ram = 18; OB.outOpen = null;
    window.__obOpen('local_pick', {stamped: ['localSetupSeenAt']});
    const root = document.getElementById('onboarding');
    const rows = [...root.querySelectorAll('.ob-models .ob-row')];
    const first = rows[0];
    const t = first ? getComputedStyle(first.querySelector('.t')) : null;
    const d = first ? getComputedStyle(first.querySelector('.d')) : null;
    const lift = getComputedStyle(root.querySelector('.ob-models')).backgroundColor;
    const probe = document.createElement('span'); probe.style.color = 'var(--ink-2)'; root.appendChild(probe);
    const ink2 = getComputedStyle(probe).color; probe.remove();
    const hf = root.querySelector('.ob-hfrow');
    const hcs = hf ? getComputedStyle(hf) : null;
    const best = root.querySelector('.ob-models .ob-badge-best');
    const out = {
      explain: ((root.querySelector('.ob-body > .ob-explain') || {}).textContent || '').trim(),
      want: 'Ordered for ' + (IS_MAC ? 'your Mac' : 'your computer') + '\\u2019s 18 GB of memory.',
      again: /after one download/.test(root.querySelector('.ob-body').textContent || ''),
      rows: rows.map((n) => ({
        id: n.dataset.model,
        h: Math.round(n.getBoundingClientRect().height * 2) / 2,
        lines: n.querySelectorAll('.d > span').length,
        badges: [...n.querySelectorAll('.t .ob-badge')].map((b) => [(b.textContent || '').trim(), b.getAttribute('title') || '']),
      })),
      small: SMALL_MODEL_CAUTION,
      name: t ? {size: parseFloat(t.fontSize), weight: Number(t.fontWeight)} : null,
      facts: d ? {size: parseFloat(d.fontSize), contrast: window.__t45.contrast(d.color, lift), ink2: window.__t45.contrast(ink2, lift)} : null,
      bestRadius: best ? getComputedStyle(best).borderTopLeftRadius : null,
      // The card's own fill (lift, or lift tinted while the pointer is on it) — a bare row has none.
      hf: hf ? {label: (hf.querySelector('.t') || {}).textContent, hint: !!hf.querySelector('.d'), chevron: !!hf.querySelector('.ob-chev svg'),
        filled: hcs.backgroundColor !== 'rgba(0, 0, 0, 0)' && hcs.backgroundColor !== 'transparent',
        shadow: hcs.boxShadow !== 'none', radius: parseFloat(hcs.borderTopLeftRadius),
        inList: !!hf.closest('.ob-models')} : null,
    };
    window.__obOpen('local_hf_ref');
    const field = document.getElementById('ob-hf-ref');
    out.placeholder = field ? field.getAttribute('placeholder') : null;
    return out;
  })()`);
  check(
    "T45: the model step says what the list is ordered for, and not \"after one download\" a second time",
    typeof r.want === "string" && r.explain === r.want && r.again === false,
    q({ explain: r.explain, want: r.want, again: r.again }),
  );
  const rows = (r.rows ?? []) as Array<{ id: string; h: number; lines: number; badges: Array<[string, string]> }>;
  const byId = (id: string) => rows.find((x) => x.id === id);
  const badgesOf = (id: string) => q(byId(id)?.badges ?? null);
  check(
    "T45: a caution is a badge on the name line with its sentence as the tooltip — tight fit, small model, reduced refusals",
    rows.length === 4
      && badgesOf("qwen-smoke-t45-best") === q([["Recommended", ""]])
      && badgesOf("qwen-smoke-t45-small") === q([["Small model", r.small]])
      && badgesOf("qwen-smoke-t45-unc") === q([["Use at your own risk", "Use at your own risk"]])
      && badgesOf("gemma-smoke-t45-tight") === q([["Tight fit", "Tight fit on 18 GB. It will run slowly."]]),
    q(rows),
  );
  check(
    "T45: every model card is the name and one facts line, so every card is the same height",
    rows.length === 4 && rows.every((x) => x.lines === 1) && new Set(rows.map((x) => x.h)).size === 1,
    q(rows.map((x) => [x.id, x.h, x.lines])),
  );
  const name = r.name as { size: number; weight: number } | null;
  const facts = r.facts as { size: number; contrast: number; ink2: number } | null;
  check(
    "T45: the name leads (larger, heavier), the facts under it are smaller and paler, and still readable",
    !!name && !!facts && name.size >= 15 && name.weight >= 650 && facts.size <= 12
      && facts.contrast < facts.ink2 && facts.contrast >= 4.5,
    q({ name, facts }),
  );
  check(
    "T45: the onboarding's badges are rounded rectangles, not pills",
    r.bestRadius === "6px",
    q({ bestRadius: r.bestRadius }),
  );
  const hf = r.hf as { label?: string; hint?: boolean; chevron?: boolean; filled?: boolean; shadow?: boolean; radius?: number; inList?: boolean } | null;
  check(
    "T45: Add a model from Hugging Face is a card of its own under the list, with a chevron and no grey hint",
    !!hf && hf.label === "Add a model from Hugging Face…" && hf.hint === false && hf.chevron === true
      && hf.filled === true && hf.shadow === true && (hf.radius ?? 0) >= 14 && hf.inList === false,
    q(hf),
  );
  check(
    "T45: the Hugging Face field's placeholder carries the hint (an owner/repo id, or a huggingface.co link)",
    typeof r.placeholder === "string" && /owner\/repo/.test(r.placeholder) && /huggingface\.co/.test(r.placeholder),
    q({ placeholder: r.placeholder }),
  );
}

/* Д10 — the models this machine cannot run, folded under their heading. */
async function outOfReach(run: Run, check: Check): Promise<void> {
  const r = await run(`(() => {
    const read = () => {
      const box = document.querySelector('#onboarding .ob-models');
      const toggle = box && box.querySelector('.ob-outtoggle');
      const list = box && box.querySelector('.ob-out-list');
      return {
        tag: toggle ? toggle.tagName : null,
        expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
        text: toggle ? (toggle.textContent || '').replace(/\\s+/g, ' ').trim() : null,
        shown: !!(list && list.offsetHeight > 0),
        rows: list ? list.querySelectorAll('.ob-out').length : 0,
        picks: box ? box.querySelectorAll('.ob-row').length : 0,
      };
    };
    OB.models = ${q(MODELS)}; OB.ram = 18; OB.outOpen = null;
    window.__obOpen('local_pick', {stamped: ['localSetupSeenAt']});
    const folded = read();
    document.querySelector('#onboarding .ob-outtoggle').click();
    const opened = read();
    document.querySelector('#onboarding .ob-outtoggle').click();
    const again = read();
    window.__obSeed({ram: 4, outOpen: null});
    const nothingRuns = read();
    return {folded, opened, again, nothingRuns, heading: 'Needs more memory than ' + THIS_MACHINE + ' has'};
  })()`);
  const folded = r.folded as Record<string, unknown> | undefined;
  const opened = r.opened as Record<string, unknown> | undefined;
  const again = r.again as Record<string, unknown> | undefined;
  const none = r.nothingRuns as Record<string, unknown> | undefined;
  check(
    "T45: the models that need more memory are folded under one heading that says how many, and are still in the page",
    !!folded && folded.tag === "BUTTON" && folded.expanded === "false" && folded.shown === false && folded.rows === 2
      && typeof folded.text === "string" && folded.text.startsWith(String(r.heading)) && /\b2\b/.test(folded.text),
    q(folded),
  );
  check(
    "T45: a click on the heading unfolds them, and another folds them again",
    !!opened && !!again && opened.expanded === "true" && opened.shown === true && opened.rows === 2
      && again.expanded === "false" && again.shown === false,
    q({ opened, again }),
  );
  check(
    "T45: when nothing in the list runs here, they start unfolded — they are the whole answer",
    !!none && none.picks === 0 && none.expanded === "true" && none.shown === true && none.rows === 6,
    q(none),
  );
}

/* Д6 — the mark a model wears with no logo of its own, and one whose file does not load. */
async function marks(run: Run, check: Check): Promise<void> {
  const r = await run(`(() => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden';
    document.body.appendChild(box);
    try {
      const out = {};
      for (const s of ['', 'sm', 'xs', 'lg']) {
        box.innerHTML = modelMark('muse-glimmer-30b', s) + logoHTML('qwen', s);
        const fb = box.children[0], logo = box.children[1];
        const a = getComputedStyle(fb), b = getComputedStyle(logo);
        out[s || 'default'] = {cls: fb.className, w: a.width, h: a.height, lw: b.width, bg: a.backgroundColor, lbg: b.backgroundColor,
          ring: a.boxShadow !== 'none', icon: !!fb.querySelector('svg'), img: !!fb.querySelector('img')};
      }
      return out;
    } finally { box.remove(); }
  })()`);
  const sizes = ["default", "sm", "xs", "lg"];
  check(
    "T45: a model with no mark of its own (Meta Muse Glimmer 30B) wears its icon on the logo's disc, at the logo's size",
    sizes.every((s) => {
      const m = r[s] as { cls?: string; w?: string; h?: string; lw?: string; bg?: string; lbg?: string; ring?: boolean; icon?: boolean; img?: boolean } | undefined;
      return !!m && /\btk-ico--mark\b/.test(m.cls ?? "") && m.w === m.lw && m.h === m.lw && m.bg === m.lbg
        && m.ring === true && m.icon === true && m.img === false;
    }),
    q(r),
  );
  const broken = await run(`(async () => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden';
    document.body.appendChild(box);
    try {
      box.innerHTML = '<span class="logo logo--xs" data-fb="cpu"><img src="logos/smoke-t45-missing.svg" alt=""></span>';
      const t0 = Date.now();
      while (Date.now() - t0 < 3000 && box.querySelector('img')) await new Promise((res) => setTimeout(res, 25));
      const fb = box.firstElementChild;
      return {img: !!box.querySelector('img'), cls: fb ? fb.className : null, icon: !!(fb && fb.querySelector('svg')), ms: Date.now() - t0};
    } finally { box.remove(); }
  })()`);
  check(
    "T45: a mark whose file does not load turns into the fallback badge, not a broken image",
    broken.img === false && /\btk-ico--mark\b/.test(String(broken.cls)) && /\btk-ico--xs\b/.test(String(broken.cls)) && broken.icon === true,
    q(broken),
  );
}

/* Д7 — across the app, a badge that does nothing is a rounded rectangle; a chip that is a button stays a pill. */
async function badges(run: Run, check: Check): Promise<void> {
  const r = await run(`(() => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden';
    box.innerHTML = '<span class="tk-chip tk-chip--sm" data-k="chip">x</span><span class="ann lit" data-k="ann">x</span>'
      + '<button class="tk-chip tk-chip--sm" data-k="button">x</button>'
      + '<div class="appr"><span class="badge" data-k="approval">x</span></div>'
      + '<div class="sysrow"><span class="sysrep" data-k="repeat">x2</span></div>'
      + '<span class="vsmbadge" data-k="voiceModel">first</span>'
      + '<div class="voicestrip"><div class="tk-vmenu"><span class="vsmbadge" data-k="voiceMenu">first</span></div></div>'
      + '<span class="dlc-count" data-k="downloads">2</span>';
    document.body.appendChild(box);
    try {
      const out = {token: getComputedStyle(document.documentElement).getPropertyValue('--r-badge').trim()};
      box.querySelectorAll('[data-k]').forEach((n) => { out[n.dataset.k] = getComputedStyle(n).borderTopLeftRadius; });
      return out;
    } finally { box.remove(); }
  })()`);
  const flat = ["chip", "ann", "approval", "repeat", "voiceModel", "voiceMenu", "downloads"];
  check(
    "T45: badges that do nothing have a 6px corner everywhere; a chip that is a button is still a pill",
    r.token === "6px" && flat.every((k) => r[k] === "6px") && r.button === "999px",
    q(r),
  );
}
