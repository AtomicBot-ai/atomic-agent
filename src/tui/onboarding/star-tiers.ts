/**
 * What a star on the intro screen looks like, as opposed to where it
 * sits: four brightnesses, the glyph each is drawn with, and how often
 * each turns up depending on what part of the sky it belongs to.
 *
 * Split from {@link ./star-field.ts} because the two answer different
 * questions and change for different reasons — the placement is geometry
 * and the ramp is design.
 */

export type StarTier = "bright" | "mid" | "dim" | "faint";

/**
 * The glyph each tier is drawn with, dimmest to brightest: a middle dot,
 * a hollow star, a filled one, and the brand cross for the rare few.
 *
 * None of them collides with either mark stroke system (`█ ▓ ░` and
 * `# + .`) — which is why the mid tier is `✦` and not the `+` it would
 * otherwise be. The renderer recovers a star's tier by looking its glyph
 * up in this table, so a shared glyph would paint part of the logo as a
 * star.
 */
export const STAR_GLYPHS: Readonly<Record<StarTier, string>> = {
  faint: "·",
  dim: "✧",
  mid: "✦",
  bright: "✛",
};

const TIER_BY_GLYPH = new Map<string, StarTier>(
  Object.entries(STAR_GLYPHS).map(([tier, glyph]) => [glyph, tier as StarTier]),
);

/** The tier a grid glyph belongs to, or null when it is not a star. */
export function starTierOfGlyph(glyph: string): StarTier | null {
  return TIER_BY_GLYPH.get(glyph) ?? null;
}

/** Tiers with the share of stars each takes, summing to one. */
export type TierWeights = readonly (readonly [StarTier, number])[];

/** Clusters carry the bright few: a core is where the big stars are. */
export const CLUSTER_TIERS: TierWeights = [
  ["bright", 0.06],
  ["mid", 0.18],
  ["dim", 0.3],
  ["faint", 0.46],
];
/** The open field is mostly dust, so it recedes behind the clusters. */
export const FIELD_TIERS: TierWeights = [
  ["bright", 0.01],
  ["mid", 0.08],
  ["dim", 0.26],
  ["faint", 0.65],
];
/** The arc is the mark's own swarm and is allowed to be the brightest thing. */
export const HALO_TIERS: TierWeights = [
  ["bright", 0.14],
  ["mid", 0.28],
  ["dim", 0.34],
  ["faint", 0.24],
];

/** The tier a roll in `[0, 1)` lands on. */
export function pickTier(weights: TierWeights, roll: number): StarTier {
  let carried = 0;
  for (const [tier, weight] of weights) {
    carried += weight;
    if (roll < carried) return tier;
  }
  return weights[weights.length - 1]![0];
}
