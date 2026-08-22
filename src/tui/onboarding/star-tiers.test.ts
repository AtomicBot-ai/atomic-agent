import { describe, expect, it } from "vitest";
import {
  CLUSTER_TIERS,
  FIELD_TIERS,
  HALO_TIERS,
  pickTier,
  STAR_GLYPHS,
  starTierOfGlyph,
} from "./star-tiers.js";

/** Every glyph either mark stroke system draws with. */
const MARK_GLYPHS = ["█", "▓", "░", "#", "+", ".", " "];

describe("STAR_GLYPHS", () => {
  it("gives each tier a glyph of its own", () => {
    const glyphs = Object.values(STAR_GLYPHS);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("shares no glyph with the mark, which would recolour part of the logo", () => {
    for (const glyph of Object.values(STAR_GLYPHS)) {
      expect(MARK_GLYPHS).not.toContain(glyph);
    }
  });

  it("round-trips a glyph back to its tier and rejects anything else", () => {
    for (const [tier, glyph] of Object.entries(STAR_GLYPHS)) {
      expect(starTierOfGlyph(glyph)).toBe(tier);
    }
    for (const glyph of MARK_GLYPHS) expect(starTierOfGlyph(glyph)).toBeNull();
  });
});

describe("pickTier", () => {
  const tables = { CLUSTER_TIERS, FIELD_TIERS, HALO_TIERS };

  it("spends the whole roll and no more", () => {
    for (const [name, table] of Object.entries(tables)) {
      const total = table.reduce((sum, [, weight]) => sum + weight, 0);
      expect({ name, total: Math.round(total * 1000) }).toEqual({ name, total: 1000 });
    }
  });

  it("walks the table in order as the roll climbs", () => {
    expect(pickTier(CLUSTER_TIERS, 0)).toBe("bright");
    expect(pickTier(CLUSTER_TIERS, 0.05)).toBe("bright");
    expect(pickTier(CLUSTER_TIERS, 0.07)).toBe("mid");
    expect(pickTier(CLUSTER_TIERS, 0.3)).toBe("dim");
    expect(pickTier(CLUSTER_TIERS, 0.9)).toBe("faint");
  });

  it("lands on the last tier rather than nothing at the top of the range", () => {
    for (const table of Object.values(tables)) {
      expect(pickTier(table, 0.999999)).toBe(table[table.length - 1]![0]);
      expect(pickTier(table, 1)).toBe(table[table.length - 1]![0]);
    }
  });

  it("makes the arc brighter than a cluster, and a cluster brighter than the field", () => {
    const bright = (table: typeof CLUSTER_TIERS): number =>
      table.find(([tier]) => tier === "bright")?.[1] ?? 0;
    expect(bright(HALO_TIERS)).toBeGreaterThan(bright(CLUSTER_TIERS));
    expect(bright(CLUSTER_TIERS)).toBeGreaterThan(bright(FIELD_TIERS));
  });
});
