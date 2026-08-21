/**
 * Regenerates `src/tui/components/logo-art.ts` from `assets/logo.svg`.
 *
 *   node scripts/generate-logo-art.mjs [--check]
 *
 * `--check` re-derives the art and exits non-zero if the checked-in file
 * has drifted, which is what `logo-art.generated.test.ts` runs.
 *
 * The mark is rasterised from the actual bezier path — flattened to a
 * polygon, then point-in-polygon with a supersampled area average — so
 * the drawing can never drift from the source asset the way a hand copy
 * does. Everything below is geometry; see the header of the generated
 * file for the design rules it encodes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SVG = join(ROOT, "assets", "logo.svg");
const OUT = join(ROOT, "src", "tui", "components", "logo-art.ts");

/** Terminal cell height ÷ width. Real fonts run 2.05–2.4. */
const ASPECT = 2.2;
/** Supersample factor per axis when measuring cell coverage. */
const SS = 4;
/** The arms occupy the middle quarter of the bounding box. */
const LO = 0.375;
const HI = 0.625;

// ---------------------------------------------------------------- path

function flatten(d, steps = 64) {
  const toks = d.match(/[MCLZmclz]|-?\d*\.?\d+/g) ?? [];
  const pts = [];
  let i = 0;
  let cur = [0, 0];
  let start = [0, 0];
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    const c = toks[i++];
    if (c === "M") {
      cur = [num(), num()];
      start = cur;
      pts.push(cur);
    } else if (c === "L") {
      cur = [num(), num()];
      pts.push(cur);
    } else if (c === "C") {
      const p1 = [num(), num()];
      const p2 = [num(), num()];
      const p3 = [num(), num()];
      for (let k = 1; k <= steps; k += 1) {
        const t = k / steps;
        const u = 1 - t;
        pts.push([
          u * u * u * cur[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * cur[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
      }
      cur = p3;
    } else if (c === "Z" || c === "z") {
      pts.push(start);
    }
  }
  return pts;
}

const svg = readFileSync(SVG, "utf8");
const pathData = /<path d="([^"]+)"/.exec(svg)?.[1];
if (!pathData) throw new Error(`no <path d="…"> in ${SVG}`);
const PTS = flatten(pathData);
const X0 = Math.min(...PTS.map((p) => p[0]));
const X1 = Math.max(...PTS.map((p) => p[0]));
const Y0 = Math.min(...PTS.map((p) => p[1]));
const Y1 = Math.max(...PTS.map((p) => p[1]));
const BW = X1 - X0;
const BH = Y1 - Y0;

/** Point-in-polygon over the flattened outline. `ux`/`uy` in [0,1], y down. */
function inside(ux, uy) {
  const x = X0 + ux * BW;
  const y = Y0 + uy * BH;
  let hit = false;
  for (let k = 0, j = PTS.length - 1; k < PTS.length; j = k, k += 1) {
    const [xi, yi] = PTS[k];
    const [xj, yj] = PTS[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// ------------------------------------------------------------- hinting
// The arm edges (0.375 / 0.625) land mid-pixel at small sizes and the
// arms come out ragged, so warp the sampling coordinate piecewise-
// linearly and pin both edges to exact pixel boundaries — font hinting.

function band(n, thick) {
  const a = Math.floor((n - thick) / 2);
  return [a, a + thick];
}

function warp(t, a, b, n) {
  const loT = a / n;
  const hiT = b / n;
  if (t <= loT) return loT > 0 ? (t * LO) / loT : LO;
  if (t >= hiT) return hiT < 1 ? HI + ((t - hiT) * (1 - HI)) / (1 - hiT) : HI;
  return LO + ((t - loT) * (HI - LO)) / (hiT - loT);
}

function coverage(px, py, W, H, bands) {
  const [ax, bx, ay, by] = bands;
  let hits = 0;
  for (let i = 0; i < SS; i += 1) {
    for (let j = 0; j < SS; j += 1) {
      if (
        inside(
          warp((px + (i + 0.5) / SS) / W, ax, bx, W),
          warp((py + (j + 0.5) / SS) / H, ay, by, H),
        )
      ) {
        hits += 1;
      }
    }
  }
  return hits / (SS * SS);
}

// --------------------------------------------------------------- grids
// The box is 4× the arm, and the arm sits centred — so the leftover
// padding is 3×arm, which is ODD when the arm is odd and lands the mark
// off-centre by a column. Widen the box by one in that case.

/** One cell = one pixel. A cell is `aspect` times taller than it is wide. */
function fullGrid(cols, aspect = ASPECT) {
  const ah = Math.max(1, Math.round(Math.round(cols / 4) / aspect));
  const av = Math.max(1, Math.round(ah * aspect));
  const W = 4 * av + (av % 2);
  const H = 4 * ah + (ah % 2);
  const bands = [...band(W, av), ...band(H, ah)];
  const g = [];
  for (let r = 0; r < H; r += 1) {
    const row = [];
    for (let c = 0; c < W; c += 1) row.push(coverage(c, r, W, H, bands) >= 0.5);
    g.push(row);
  }
  return { g, W, H, av, ah };
}

// ---------------------------------------------------------------- 3-D
// Depth sweeps bottom-right at a true 45° ON SCREEN. A cell is `aspect`
// times taller than wide, so that is ~2.2 columns per row — stepping one
// column per row would lean at ~65° and read as a shear. Offsets are
// enumerated by column so every intermediate column is covered and the
// side walls come out solid rather than dashed.

function sweep(face, dcols, aspect) {
  const out = new Set();
  for (const dc of dcols) {
    const dr = Math.round(dc / aspect);
    for (const key of face) {
      const [r, c] = key.split(",").map(Number);
      out.add(`${r + dr},${c + dc}`);
    }
  }
  return out;
}

function paint(layers) {
  const all = new Set();
  for (const [set] of layers) for (const k of set) all.add(k);
  const rs = [...all].map((k) => Number(k.split(",")[0]));
  const cs = [...all].map((k) => Number(k.split(",")[1]));
  const r0 = Math.min(...rs);
  const r1 = Math.max(...rs);
  const c0 = Math.min(...cs);
  const c1 = Math.max(...cs);
  const rows = [];
  for (let r = r0; r <= r1; r += 1) {
    let line = "";
    for (let c = c0; c <= c1; c += 1) {
      let ch = " ";
      for (const [set, glyph] of layers) if (set.has(`${r},${c}`)) ch = glyph;
      line += ch;
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows;
}

function faceSet(g, W, H) {
  const s = new Set();
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) if (g[r][c]) s.add(`${r},${c}`);
  }
  return s;
}

const STROKES = {
  block: { face: "█", wall: "▓", shade: "░" },
  ascii: { face: "#", wall: "+", shade: "." },
};

/** LG: face + extruded walls + a contact shadow. */
function renderBoth(cols, ch, aspect = ASPECT) {
  const { g, W, H, av } = fullGrid(cols, aspect);
  const face = faceSet(g, W, H);
  const dcol = Math.max(2, Math.round(av / 3));
  const gap = Math.max(1, Math.round(dcol * 0.6));
  const body = sweep(face, range(1, dcol), aspect);
  const shade = sweep(face, [dcol + gap], aspect);
  for (const k of face) {
    body.delete(k);
    shade.delete(k);
  }
  for (const k of body) shade.delete(k);
  return paint([[shade, ch.shade], [body, ch.wall], [face, ch.face]]);
}

/** MD: face + extruded walls, no contact shadow. */
function renderExtrude(cols, ch, wallGlyph, aspect = ASPECT) {
  const { g, W, H, av } = fullGrid(cols, aspect);
  const face = faceSet(g, W, H);
  const dcol = Math.max(2, Math.round(av / 3));
  const body = sweep(face, range(1, dcol), aspect);
  for (const k of face) body.delete(k);
  return paint([[body, wallGlyph], [face, ch.face]]);
}

/**
 * SM: a one-column right bevel and no vertical offset at all. At this
 * size each arm is one row tall, so a shadow offset down lands against
 * the bar and reads as a second bar rather than as depth.
 */
function renderBevel(cols, ch, aspect = ASPECT) {
  const { g, W, H } = fullGrid(cols, aspect);
  const face = faceSet(g, W, H);
  const shade = new Set();
  for (const k of face) {
    const [r, c] = k.split(",").map(Number);
    const key = `${r},${c + 1}`;
    if (!face.has(key)) shade.add(key);
  }
  return paint([[shade, ch.shade], [face, ch.face]]);
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

// -------------------------------------------------------------- emit

const SCALES = { lg: 45, md: 29, sm: 8 };

function art(scale, stroke) {
  const ch = STROKES[stroke];
  if (scale === "lg") return renderBoth(SCALES.lg, ch);
  if (scale === "sm") return renderBevel(SCALES.sm, ch);
  // MD/block draws its walls in the light `░` so it matches the rail
  // mark's tone; the ASCII ramp is already low-contrast and would lose
  // the depth entirely if it dropped to `.`.
  return renderExtrude(SCALES.md, ch, stroke === "block" ? ch.shade : ch.wall);
}

function lit(rows, indent) {
  const pad = " ".repeat(indent);
  return rows.map((r) => `${pad}${JSON.stringify(r)},`).join("\n");
}

function block(stroke) {
  return ["lg", "md", "sm"]
    .map((scale) => {
      const rows = art(scale, stroke);
      const w = Math.max(...rows.map((r) => r.length));
      return `  // ${w} x ${rows.length}\n  ${scale}: [\n${lit(rows, 4)}\n  ],`;
    })
    .join("\n");
}

const out = `/**
 * Brand-mark artwork: the Atomic cross at three scales, in two stroke
 * systems, plus a dedicated rail mark.
 *
 * GENERATED FROM \`assets/logo.svg\` by \`scripts/generate-logo-art.mjs\`.
 * Do not hand-edit — redraw the SVG and regenerate.
 * \`logo-art.generated.test.ts\` fails if this file drifts from the source.
 *
 * **Why separate drawings instead of one scaled at runtime.** These
 * marks carry depth in up to three tones — face, extruded wall, cast
 * shadow. The rasteriser this replaced scaled one drawing by first
 * flattening it to a boolean ink mask, in which every non-space glyph
 * counts as ink; run these through it and \`#\`, \`+\` and \`.\` collapse
 * into one solid blob with the depth gone. Tone has to be re-decided per
 * size, not resampled.
 *
 * The ladder is quantized rather than continuous anyway: the arm is
 * exactly a quarter of the bounding box and must be a whole number of
 * cells, so the usable sizes are fixed points with nothing to
 * interpolate between.
 *
 * Geometry rules the artwork obeys, should the SVG ever be redrawn:
 *
 * - The concave fillet is in the **top-left** and **bottom-right**
 *   quadrants only. Top-right and bottom-left are straight segments
 *   meeting at a hard 90°. The mark is 180°-symmetric, not 4-fold, so
 *   mirroring or v-flipping it yields a *different* logo.
 * - The fillets leave each arm edge tangentially: the arms stay
 *   parallel-sided near the tips and flare only toward the centre.
 * - Depth sweeps bottom-right (observer there, light from the top-left)
 *   at a true 45° *on screen* — which at a ~2.2:1 cell aspect means
 *   ~2.2 columns per row, not one.
 */

/** Which drawing to use. A bigger scale is not a scaled-up smaller one. */
export type MarkScale = "lg" | "md" | "sm";

/**
 * Glyph system. \`block\` uses Unicode block elements; \`ascii\` stays in
 * plain ASCII so it survives \`TERM=dumb\`, CI log scrapes and non-UTF-8
 * locales.
 */
export type MarkStroke = "block" | "ascii";

export type MarkArt = Readonly<Record<MarkScale, readonly string[]>>;

/** \`█\` face, \`▓\` wall, \`░\` shadow. */
const BLOCK: MarkArt = {
${block("block")}
};

/** \`#\` face, \`+\` wall, \`.\` shadow. */
const ASCII: MarkArt = {
${block("ascii")}
};

export const CROSS_MARKS: Readonly<Record<MarkStroke, MarkArt>> = {
  block: BLOCK,
  ascii: ASCII,
};
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== out) {
    console.error(
      `${OUT} is stale.\nRun: node scripts/generate-logo-art.mjs`,
    );
    process.exit(1);
  }
  console.log("logo-art.ts is in sync with assets/logo.svg");
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}
