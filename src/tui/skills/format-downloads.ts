/**
 * Compact human formatting for ClawHub download counts shown in the hub
 * list and the pre-install card. Mirrors the GitHub-stars style: `942`,
 * `1.2k`, `464k`, `2.1M`. `undefined` (GitHub taps expose no count)
 * renders as an em dash so the column stays aligned.
 */
export function formatDownloads(downloads: number | undefined): string {
  if (downloads === undefined) return "—";
  if (downloads < 1000) return String(downloads);
  if (downloads < 1_000_000) return `${trim(downloads / 1000)}k`;
  return `${trim(downloads / 1_000_000)}M`;
}

function trim(value: number): string {
  // One decimal under 10 (1.2k), none above (12k) — keeps the column tight.
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return String(rounded);
}
