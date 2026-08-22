/**
 * The sky the intro's brand mark hangs in.
 *
 * A field rather than a ring: a few cluster centres with members
 * scattered around them at a falling-off density, sparse field stars in
 * between, and four brightness tiers for the renderer to vary colour by.
 * Evenly spaced glyphs at one radius read as a diagram of an atom; real
 * sky is clumpy, and the clumps are what make it read as depth.
 *
 * Pure, React-free and seeded rather than random. Seeded matters twice:
 * a test can assert an exact field, and a re-render partway through the
 * tagline animation cannot reshuffle the stars under the operator.
 */

import { CELL_ASPECT, computeOrbitField } from "./orbit-field.js";
import {
  CLUSTER_TIERS,
  FIELD_TIERS,
  HALO_TIERS,
  pickTier,
  type StarTier,
} from "./star-tiers.js";

export interface Star {
  row: number;
  column: number;
  tier: StarTier;
}

/** Columns of one canvas row that the mark owns. Inclusive on both ends. */
export interface ClearSpan {
  row: number;
  from: number;
  to: number;
}

/** The arc of stars still caught in orbit around the mark. */
export interface StarHalo {
  center: { row: number; column: number };
  /** Horizontal radius in columns; the vertical one follows the aspect. */
  radius: number;
  count: number;
}

export interface StarFieldOptions {
  columns: number;
  rows: number;
  /** Where the mark and its clear space sit. No star lands inside one. */
  clearSpans?: readonly ClearSpan[];
  /** Multiplier on the designed density. Zero leaves the field empty. */
  density?: number;
  /** Fixed by default, so one terminal size always paints one sky. */
  seed?: number;
  halo?: StarHalo;
}

/**
 * Stars per canvas cell at density 1, before the clear space takes its
 * bite. Count scales with area rather than being a fixed number, so a
 * 120×40 terminal is a bigger sky and not the same handful spread thin.
 */
const STARS_PER_CELL = 0.08;
/** Share of the sky that belongs to a cluster rather than the open field. */
const CLUSTERED_SHARE = 0.62;
const MIN_CLUSTERS = 2;
const MAX_CLUSTERS = 6;
/** One cluster per this much of the canvas's geometric mean side. */
const CLUSTER_SPACING = 11;
const MIN_CLUSTER_RADIUS = 5;
const MAX_CLUSTER_RADIUS = 16;
/** Tries before a star is abandoned rather than stacked on a taken cell. */
const PLACEMENT_ATTEMPTS = 4;
const CENTRE_ATTEMPTS = 24;
/** How far a halo star may drift off the exact ellipse. */
const HALO_JITTER_COLUMNS = 2;
const HALO_JITTER_ROWS = 1;
/** Share of halo positions left empty, so the arc is broken rather than drawn. */
const HALO_GAP_CHANCE = 0.25;
/** Rotation that keeps the arc off the vertical and horizontal axes. */
const HALO_PHASE = Math.PI / 12;
/**
 * Picked by sweeping seeds at 96×20 — the canvas a 100×30 terminal
 * gives — and keeping the one whose thinnest sixth of the sky was still
 * populated. Nothing depends on the number itself.
 */
const DEFAULT_SEED = 82;

interface Cluster {
  column: number;
  row: number;
  /** Horizontal reach in columns; the vertical one follows the aspect. */
  radius: number;
}

/** What the placement helpers need: the canvas, the rolls, and the grid. */
interface Sky {
  columns: number;
  rows: number;
  random(): number;
  free(column: number, row: number): boolean;
  place(column: number, row: number, tier: StarTier): void;
}

export function computeStarField(options: StarFieldOptions): Star[] {
  const { columns, rows } = options;
  if (columns <= 0 || rows <= 0) return [];
  const density = Math.max(0, options.density ?? 1);
  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  const occupied = blockedCells(options.clearSpans ?? [], columns, rows);
  const stars: Star[] = [];
  const sky: Sky = {
    columns,
    rows,
    random,
    free: (column, row) =>
      column >= 0 &&
      column < columns &&
      row >= 0 &&
      row < rows &&
      !occupied.has(row * columns + column),
    place: (column, row, tier) => {
      occupied.add(row * columns + column);
      stars.push({ column, row, tier });
    },
  };

  // The arc is placed first because it is the one part of the field with
  // a shape to keep: a cluster member that happened to roll onto the
  // ellipse would otherwise take the cell the arc needed.
  if (options.halo) placeHalo(sky, options.halo);

  const target = Math.round(columns * rows * STARS_PER_CELL * density);
  if (target <= 0) return stars;
  const clusters = buildClusters(sky, options.halo);
  const clustered = clusters.length > 0 ? Math.round(target * CLUSTERED_SHARE) : 0;
  for (let i = 0; i < clustered; i += 1) {
    placeClusterStar(sky, clusters[i % clusters.length]!);
  }
  for (let i = 0; i < target - clustered; i += 1) {
    placeFieldStar(sky);
  }
  return stars;
}

function placeHalo(sky: Sky, halo: StarHalo): void {
  const cells = computeOrbitField({
    columns: sky.columns,
    rows: sky.rows,
    center: halo.center,
    radius: halo.radius,
    count: halo.count,
    phase: HALO_PHASE,
  });
  for (const cell of cells) {
    // Jitter and gaps are the whole point of routing the ring through
    // here. The exact ellipse is kept as the arc's spine so the mark
    // still reads as an atom, but nothing lands on it dead on.
    if (sky.random() < HALO_GAP_CHANCE) continue;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
      const column = cell.column + jitter(sky.random(), HALO_JITTER_COLUMNS);
      const row = cell.row + jitter(sky.random(), HALO_JITTER_ROWS);
      if (!sky.free(column, row)) continue;
      sky.place(column, row, pickTier(HALO_TIERS, sky.random()));
      break;
    }
  }
}

function buildClusters(sky: Sky, halo: StarHalo | undefined): Cluster[] {
  const side = Math.sqrt(sky.columns * sky.rows);
  const wanted = clamp(Math.round(side / CLUSTER_SPACING), MIN_CLUSTERS, MAX_CLUSTERS);
  const radius = clamp(sky.columns / 8, MIN_CLUSTER_RADIUS, MAX_CLUSTER_RADIUS);
  const clusters: Cluster[] = [];
  for (let i = 0; i < wanted; i += 1) {
    for (let attempt = 0; attempt < CENTRE_ATTEMPTS; attempt += 1) {
      const column = Math.floor(sky.random() * sky.columns);
      const row = Math.floor(sky.random() * sky.rows);
      // A centre inside the mark's clear space would have most of its
      // members rejected and the rest strung along the edge of the hole.
      if (!sky.free(column, row)) continue;
      // Clusters keep out to the far side of the arc, so an unlucky
      // seed cannot drop a core on top of the mark's swarm and bury it.
      if (halo && visualDistance(halo.center, { column, row }) < halo.radius) continue;
      if (clusters.some((other) => visualDistance(other, { column, row }) < radius)) {
        continue;
      }
      clusters.push({ column, row, radius });
      break;
    }
  }
  return clusters;
}

function placeClusterStar(sky: Sky, cluster: Cluster): void {
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const angle = sky.random() * Math.PI * 2;
    // Squaring the roll packs members toward the core. A uniform radius
    // spreads them over a disc whose circumference grows with r, and
    // comes out looking like a ring rather than a cluster.
    const reach = cluster.radius * sky.random() ** 2;
    const column = Math.round(cluster.column + Math.cos(angle) * reach);
    const row = Math.round(cluster.row + (Math.sin(angle) * reach) / CELL_ASPECT);
    if (!sky.free(column, row)) continue;
    sky.place(column, row, pickTier(CLUSTER_TIERS, sky.random()));
    return;
  }
}

function placeFieldStar(sky: Sky): void {
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const column = Math.floor(sky.random() * sky.columns);
    const row = Math.floor(sky.random() * sky.rows);
    if (!sky.free(column, row)) continue;
    sky.place(column, row, pickTier(FIELD_TIERS, sky.random()));
    return;
  }
}

/** Distance in screen units, where a row is `CELL_ASPECT` columns tall. */
function visualDistance(
  a: { column: number; row: number },
  b: { column: number; row: number },
): number {
  return Math.hypot(a.column - b.column, (a.row - b.row) * CELL_ASPECT);
}

function jitter(roll: number, reach: number): number {
  return Math.round((roll - 0.5) * 2 * reach);
}

function blockedCells(
  spans: readonly ClearSpan[],
  columns: number,
  rows: number,
): Set<number> {
  const cells = new Set<number>();
  for (const span of spans) {
    if (span.row < 0 || span.row >= rows) continue;
    const from = Math.max(0, span.from);
    const to = Math.min(columns - 1, span.to);
    for (let column = from; column <= to; column += 1) {
      cells.add(span.row * columns + column);
    }
  }
  return cells;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * mulberry32: thirty-odd bits of state, a handful of multiplies, and a
 * period long enough for a few hundred stars. `Math.random` is not an
 * option here — the field has to be the same on every render.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
