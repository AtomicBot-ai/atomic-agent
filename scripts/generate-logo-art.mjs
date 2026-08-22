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
 * SM: three rows, one-cell arms, a sub-cell fillet in each concave
 * corner and a one-column right bevel.
 *
 *      ▗█░
 *    █████░
 *      █▘░
 *
 * **This one is constructed, not rasterised.** Every other size samples
 * the bezier path; this one cannot. The arm is a quarter of the box, so
 * a one-column arm implies a five-row box at a 2.2:1 cell — there is no
 * sampling of the path that yields three rows with arms still on it.
 * `fullGrid(5)` rounds straight back up to a two-column arm. So the
 * geometry is written out here instead: arm 1 cell, bar 4×arm + 1 for
 * centring, which is the same proportion the other sizes obey, quantised
 * to the smallest grid that can still carry it.
 *
 * It is a *sign* at this size rather than a reproduction, and that is
 * the point: it sits inline beside text — the rail lockup, the setup
 * headers — where five rows of logo out-shout the words next to them.
 *
 * **The fillets.** The concave diagonal (top-left, bottom-right) is what
 * distinguishes this mark from a plain cross, and at one cell per arm
 * there is no room to draw it in whole cells. A quadrant block puts the
 * ink in the corner it belongs to at half the size — the only sub-cell
 * tool a terminal offers. The hard 90° corners (top-right, bottom-left)
 * stay empty; filleting all four would make the mark 4-fold symmetric,
 * which is a different logo.
 *
 * ASCII has no quadrant glyphs, so that stroke keeps plain cells. The
 * charset is pinned by `logo-art.generated.test.ts`.
 */
function renderSmall(ch, stroke) {
  const arm = 1;
  const width = 4 * arm + 1;
  const armCol = Math.floor(width / 2);
  const face = new Set([`0,${armCol}`, `2,${armCol}`]);
  for (let c = 0; c < width; c += 1) face.add(`1,${c}`);
  // Top-left and bottom-right only — the 180°-symmetric pair.
  const fillets = new Map();
  if (stroke === "block") {
    fillets.set(`0,${armCol - 1}`, "▗");
    fillets.set(`2,${armCol + 1}`, "▘");
  }
  const ink = new Set([...face, ...fillets.keys()]);
  const shade = new Set();
  for (const k of ink) {
    const [r, c] = k.split(",").map(Number);
    const key = `${r},${c + 1}`;
    if (!ink.has(key)) shade.add(key);
  }
  const layers = [[shade, ch.shade], [face, ch.face]];
  for (const [key, glyph] of fillets) layers.push([new Set([key]), glyph]);
  return paint(layers);
}

/**
 * XS: two rows, a half-cell cross for terminals where even the SM sign
 * is too tall — the minimal onboarding tier, a splash pane a few rows
 * high.
 *
 *    ▗█▄░
 *    ▀█▘░
 *
 * Constructed like SM — there is no grid this small the sampler can
 * land on. The horizontal bar is drawn in half-cells so it can sit
 * *between* the two rows: `▄` (bottom half) and `▀` (top half) fuse
 * across the row seam into a three-cell bar vertically centred on the
 * full-cell arm running through the middle column.
 *
 * The identity survives in the bar's corners: `▗` pulls the top-left
 * tip in and `▘` the bottom-right — the same concave pair SM fillets —
 * so the sign stays 180°-symmetric rather than 4-fold, which is the
 * one property separating this mark from a generic plus.
 *
 * ASCII has no sub-cell glyphs (charset pinned by the generated test),
 * so that stroke degrades to a one-cell stub over a bar: the same thin
 * plus its SM already draws, one row shorter.
 */
function renderTiny(ch, stroke) {
  const width = 3;
  const armCol = 1;
  const face = new Set();
  const partials = new Map();
  if (stroke === "block") {
    face.add(`0,${armCol}`).add(`1,${armCol}`);
    partials.set(`0,${armCol - 1}`, "▗");
    partials.set(`0,${armCol + 1}`, "▄");
    partials.set(`1,${armCol - 1}`, "▀");
    partials.set(`1,${armCol + 1}`, "▘");
  } else {
    face.add(`0,${armCol}`);
    for (let c = 0; c < width; c += 1) face.add(`1,${c}`);
  }
  const ink = new Set([...face, ...partials.keys()]);
  const shade = new Set();
  for (const k of ink) {
    const [r, c] = k.split(",").map(Number);
    const key = `${r},${c + 1}`;
    if (!ink.has(key)) shade.add(key);
  }
  const layers = [[shade, ch.shade], [face, ch.face]];
  for (const [key, glyph] of partials) layers.push([new Set([key]), glyph]);
  return paint(layers);
}

/** Kept for reference: the five-row bevelled mark the SM size replaced. */
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

// `sm` and `xs` take no nominal width: they are constructed, not sampled.
const SCALES = { lg: 45, md: 29 };

function art(scale, stroke) {
  const ch = STROKES[stroke];
  if (scale === "lg") return renderBoth(SCALES.lg, ch);
  if (scale === "sm") return renderSmall(ch, stroke);
  if (scale === "xs") return renderTiny(ch, stroke);
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
  return ["lg", "md", "sm", "xs"]
    .map((scale) => {
      const rows = art(scale, stroke);
      const w = Math.max(...rows.map((r) => r.length));
      return `  // ${w} x ${rows.length}\n  ${scale}: [\n${lit(rows, 4)}\n  ],`;
    })
    .join("\n");
}

const out = `/**
 * Brand-mark artwork: the Atomic cross at four scales, in two stroke
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
export type MarkScale = "lg" | "md" | "sm" | "xs";

/**
 * Glyph system. \`block\` uses Unicode block elements; \`ascii\` stays in
 * plain ASCII so it survives \`TERM=dumb\`, CI log scrapes and non-UTF-8
 * locales.
 */
export type MarkStroke = "block" | "ascii";

export type MarkArt = Readonly<Record<MarkScale, readonly string[]>>;

/**
 * Glyphs that draw a mark's front plane, sub-cell face ink included —
 * SM's fillets, XS's half-cell bar. Everything else in the art is
 * depth (extruded wall, cast shadow) or blank. Exported from here so
 * every renderer colours the same glyphs as face instead of keeping a
 * private copy that drifts when the art gains a glyph.
 */
export const FACE_GLYPHS: ReadonlySet<string> = new Set([
  "#",
  "\\u2588", // █ full block
  "\\u2597", // ▗ SM/XS concave fillet, top-left
  "\\u2598", // ▘ SM/XS concave fillet, bottom-right
  "\\u2584", // ▄ lower half block — XS bar, top row
  "\\u2580", // ▀ upper half block — XS bar, bottom row
]);

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
