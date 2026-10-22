// ATO-820: the tertiary ink (--ink-3) must keep 4.5:1 on a row under the
// pointer (--hover, ink at 6%) and a pressed row (--press, ink at 10%) over
// every ground a row sits on, in both themes. It read 3.6 to 4.4 there.
//
// styles.css is read as text; the washes are recomputed here the way
// color-mix(in srgb, ink N%, transparent) composites over the ground.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../renderer/styles.css", import.meta.url), "utf8");

function token(name) {
  const m = css.match(new RegExp("--" + name + ":\\s*(#[0-9A-Fa-f]{6})"));
  assert.ok(m, "styles.css declares --" + name);
  return m[1];
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c) => {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const over = (top, ground, alpha) => top.map((v, i) => v * alpha + ground[i] * (1 - alpha));
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

for (const theme of ["p", "i"]) {
  test(`--${theme}-ink-3 keeps 4.5:1 on hovered and pressed rows`, () => {
    const ink = rgb(token(theme + "-ink"));
    const ink3 = rgb(token(theme + "-ink-3"));
    for (const ground of ["paper", "panel", "panel-2", "well", "lift"]) {
      for (const [wash, alpha] of [["rest", 0], ["hover", 0.06], ["press", 0.10]]) {
        const bg = over(ink, rgb(token(theme + "-" + ground)), alpha);
        const r = ratio(ink3, bg);
        assert.ok(r >= 4.5, `--${theme}-ink-3 on ${ground} (${wash}) is ${r.toFixed(2)}:1`);
      }
    }
  });
}
