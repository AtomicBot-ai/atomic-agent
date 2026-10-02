/**
 * Release-fix checks for backlog item 61 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=61`.
 *
 * 61 — Settings › Diagnostics: the row's icon looked cut off. The `gauge`
 * glyph was only the upper half of a dial (y 5.5..11 in a 16×16 box), so in
 * the nav it read as a circle missing its bottom. Checked: the Diagnostics
 * row's icon lies inside its viewBox and is a whole, centred glyph.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

export async function checks61(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0';
    host.innerHTML = settingsNavHTML('diagnostics');
    document.body.appendChild(host);
    try {
      const row = host.querySelector('[data-act="settings:diagnostics"]');
      const svg = row && row.querySelector('svg');
      if (!svg) return {svg: false};
      const vb = svg.viewBox.baseVal;
      const b = svg.getBBox();
      return {svg: true, vb: [vb.x, vb.y, vb.width, vb.height], bb: [b.x, b.y, b.width, b.height]};
    } finally { host.remove(); }
  })()`);
  const vb = (r["vb"] ?? []) as number[];
  const bb = (r["bb"] ?? []) as number[];
  const inside = r["svg"] === true && vb.length === 4 && bb.length === 4
    && bb[0]! >= vb[0]! && bb[1]! >= vb[1]!
    && bb[0]! + bb[2]! <= vb[0]! + vb[2]! && bb[1]! + bb[3]! <= vb[1]! + vb[3]!;
  check("T61: the Diagnostics row's icon lies inside its viewBox", inside, JSON.stringify(r));
  const cy = bb.length === 4 ? bb[1]! + bb[3]! / 2 : NaN;
  check(
    "T61: the Diagnostics icon is a whole glyph, not half a dial (tall as it is wide, centred)",
    bb.length === 4 && bb[3]! >= 9 && Math.abs(bb[3]! - bb[2]!) <= 1.5 && Math.abs(cy - (vb[1]! + vb[3]! / 2)) <= 1,
    JSON.stringify(r),
  );
}
