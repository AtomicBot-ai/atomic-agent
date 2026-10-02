import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Release-fix checks for backlog item 37 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=37`.
 *
 * 37 — Settings › Models: on the selected model row the green "In use" sat in
 * a dark pill with almost no padding, a stain on the blue (--brand-wash) row.
 * Every row's action pill took a --lift fill on hover, the label included,
 * whose padding is 0 2px: near-black behind it in the dark theme, white in
 * the light one. "In use" is a label, not a button — no fill on any row, in
 * either theme — while the pills that do something ("Use", the Custom server
 * row's "Edit address") keep theirs.
 *
 * `:hover` cannot be synthesised from script, so the hover half is read off
 * the stylesheets the window loaded, from disk (a file:// document may refuse
 * cssRules): every rule that fills a background under `:hover` is matched,
 * with the `:hover` taken out, against the elements of rows the window draws
 * with its own llmRowHTML. The rest is the computed style, in both themes.
 * Nothing is written; the staged rows are removed again.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

/** The renderer's stylesheets, in the order index.html links them. */
function rendererCss(): string {
  const dir = join(__dirname, "..", "..", "renderer");
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]!);
  return sheets.map((href) => { try { return readFileSync(join(dir, href), "utf8"); } catch { return ""; } }).join("\n");
}

/** A selector list split on its top-level commas (`:is(a, b)` stays whole). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every `:hover` selector whose rule fills a background, with `:hover` taken out. */
function hoverFills(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]!;
    const fills = [...body.matchAll(/background(?:-color)?\s*:\s*([^;]+)/g)].some((b) => !/^\s*(transparent|none|initial|inherit|unset)\s*(!important)?\s*$/.test(b[1]!));
    if (!fills) continue;
    for (const sel of splitSelectors(m[1]!.trim())) {
      if (sel.startsWith("@") || !sel.includes(":hover")) continue;
      out.push(sel.replace(/:hover/g, ""));
    }
  }
  return out;
}

export async function checks37(js: Js, check: Check): Promise<void> {
  const fills = hoverFills(rendererCss());
  const r = await js<Record<string, any>>(`(() => {
    const host = document.createElement('div');
    host.className = 'llm-pane';
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:720px';
    const row = (o, i, cursor) => llmRowHTML(Object.assign({active:false, available:true, enterEffect:'', text:''}, o), i, cursor);
    const model = (id) => ({id, name:'Smoke T37 ' + id, size:'1.0 GB', sizeGb:1, downloaded:true});
    host.innerHTML = '<div class="tk-list llm-list">'
      // The row in use, selected — the one in the report.
      + row({kind:'localTextModel', id:'local-text:smoke-t37-inuse', model:model('inuse'), active:true, primaryAction:'current',
          enterEffect:'Current: local-llama/smoke-t37-inuse', text:'smoke-t37-inuse 1.0 GB [downloaded]', sub:'smoke'}, 0, 0)
      + row({kind:'localTextModel', id:'local-text:smoke-t37-dl', model:Object.assign(model('dl'), {downloaded:false}), primaryAction:'downloading',
          enterEffect:'Downloading…', text:'smoke-t37-dl 1.0 GB [remote]', sub:'smoke'}, 1, 0)
      + row({kind:'localTextModel', id:'local-text:smoke-t37-use', model:model('use'), primaryAction:'use',
          enterEffect:'Enter: select model', text:'smoke-t37-use 1.0 GB [downloaded]', sub:'smoke'}, 2, 0)
      + row({kind:'externalUrl', id:'external-url', url:'http://127.0.0.1:8080', active:true, primaryAction:'current',
          enterEffect:'Enter: edit the base URL', text:'base URL http://127.0.0.1:8080 [healthy]'}, 3, 0)
      + '</div>';
    document.body.appendChild(host);
    const root = document.documentElement, had = root.getAttribute('data-theme');
    const pick = (sel) => host.querySelector(sel);
    const els = {inUse: pick('[data-llm-row="local-text:smoke-t37-inuse"] .llm-effect'), downloading: pick('[data-llm-row="local-text:smoke-t37-dl"] .llm-effect'),
      use: pick('[data-llm-row="local-text:smoke-t37-use"] .llm-effect'), edit: pick('[data-llm-row="external-url"] .llm-effect')};
    try {
      const hover = {};
      for (const [k, el] of Object.entries(els)) {
        hover[k] = el ? ${JSON.stringify(fills)}.filter((sel) => { try { return el.matches(sel); } catch (e) { return false; } }) : null;
      }
      const probe = document.createElement('span'); probe.style.color = 'var(--success)'; host.appendChild(probe);
      const themes = {};
      for (const theme of ['light', 'dark']) {
        root.setAttribute('data-theme', theme);
        const cs = getComputedStyle(els.inUse);
        const rowCs = getComputedStyle(pick('[data-llm-row="local-text:smoke-t37-inuse"]'));
        themes[theme] = {text: els.inUse.textContent, bg: cs.backgroundColor, shadow: cs.boxShadow, color: cs.color, success: getComputedStyle(probe).color,
          rowBg: rowCs.backgroundColor, selected: pick('[data-llm-row="local-text:smoke-t37-inuse"]').classList.contains('on')};
      }
      return {hover, themes, rules: ${JSON.stringify(fills.length)}};
    } finally {
      if (had == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', had);
      host.remove();
    }
  })()`);
  const hover = (r["hover"] ?? {}) as Record<string, string[] | null>;
  check(
    "T37: no hover rule fills the background behind \"In use\" or \"Downloading…\" — they are labels, not buttons",
    Array.isArray(hover["inUse"]) && hover["inUse"]!.length === 0 && Array.isArray(hover["downloading"]) && hover["downloading"]!.length === 0,
    JSON.stringify({ inUse: hover["inUse"], downloading: hover["downloading"], rules: r["rules"] }),
  );
  check(
    "T37: the pills that do something keep their hover fill — \"Use\", and the Custom server row's \"Edit address\"",
    (hover["use"]?.length ?? 0) > 0 && (hover["edit"]?.length ?? 0) > 0,
    JSON.stringify({ use: hover["use"], edit: hover["edit"] }),
  );
  const themes = (r["themes"] ?? {}) as Record<string, { text: string; bg: string; shadow: string; color: string; success: string; rowBg: string; selected: boolean }>;
  const plain = (t: (typeof themes)[string] | undefined) =>
    !!t && t.text === "In use" && t.bg === "rgba(0, 0, 0, 0)" && t.shadow === "none" && t.color === t.success && t.selected && t.rowBg !== "rgba(0, 0, 0, 0)";
  check(
    "T37: on the selected (blue) row \"In use\" is green words with nothing behind them, in the light and the dark theme",
    plain(themes["light"]) && plain(themes["dark"]) && themes["light"]!.success !== themes["dark"]!.success,
    JSON.stringify(themes),
  );
}
