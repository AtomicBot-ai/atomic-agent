/**
 * Release-fix checks for backlog item 53 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=53`.
 *
 * 53 (ATO-163) — "Tables in a reply show as raw markdown." A reply with a
 * table reached the screen as `| # | Таска |` and `|---|---|`. renderMarkdown
 * now draws GitHub-style tables: a header row, a dashed separator, body rows,
 * alignment from the separator's colons, a `\|` kept as a pipe, and a lone
 * `---` under a line with a pipe still a rule, a separator with another
 * number of cells than the header not a table, `|-|-|` a separator. Checked on renderProse, the
 * one renderer every reply goes through, and on the drawn table's layout:
 * it scrolls sideways inside the reply rather than widening it.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);

export async function checks53(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const md = ['Level 1', '| # | Таска | Что проверяет |', '|---|:------|--------------:|',
      '| 1 | «Скажи время» | \`os.date\` |', '| 2 | a \\\\| b | **жирный** |', '', 'после', 'a | b', '---', '',
      '| wide | table |', '|-|-|', '| ' + 'x'.repeat(400) + ' | y |', '', 'use a || b here', '|---|'].join('\\n');
    const host = document.createElement('div');
    host.className = 'prose';
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px';
    host.innerHTML = renderProse(md);
    document.body.appendChild(host);
    try {
      const t = host.querySelector('.mdtbl table');
      const cells = (sel) => t ? [...t.querySelectorAll(sel)].map((c) => c.textContent) : [];
      const wrap = host.querySelector('.mdtbl');
      return {
        tables: host.querySelectorAll('table').length, head: cells('thead th'), body: cells('tbody td'),
        align: t ? [...t.querySelectorAll('thead th')].map((c) => c.style.textAlign) : [],
        strong: !!(t && t.querySelector('td strong')), code: !!(t && t.querySelector('td code')),
        // pipesLeft: the two tables' own rows only; the prose case keeps its pipes.
        pipesLeft: /# \\| Таска|\\|---\\|:-|\\|-\\|-\\|/.test(host.textContent), hr: host.querySelectorAll('hr.mdhr').length,
        wraps: wrap ? getComputedStyle(wrap).overflowX : null, hostW: host.scrollWidth,
        wide: (() => { const w = host.querySelectorAll('.mdtbl')[1]; return w ? {scroll: w.scrollWidth, client: w.clientWidth} : null; })(),
      };
    } finally { host.remove(); }
  })()`);
  check(
    "T53: a markdown table in a reply is drawn as a table — header, two rows, the separator's alignment, inline marks inside cells",
    r["tables"] === 2 && show(r["head"]) === show(["#", "Таска", "Что проверяет"]) && (r["body"] as unknown[]).length === 6
      && show(r["align"]) === show(["", "left", "right"]) && r["strong"] === true && r["code"] === true,
    show(r),
  );
  check(
    "T53: no pipes or dashes left as text, an escaped pipe stays a pipe, and a lone --- under a line with a pipe is still a rule",
    r["pipesLeft"] === false && (r["body"] as string[]).includes("a | b") && r["hr"] === 1
      && r["tables"] === 2,   // "use a || b here" over a one-cell separator stays prose: the cell counts differ
    show(r),
  );
  check(
    "T53: the table scrolls sideways inside the reply instead of widening it",
    r["wraps"] === "auto" && Number(r["hostW"]) <= 320
      && !!r["wide"] && (r["wide"] as { scroll: number; client: number }).scroll > (r["wide"] as { scroll: number; client: number }).client,
    show({ wraps: r["wraps"], hostW: r["hostW"], wide: r["wide"] }),
  );
}
