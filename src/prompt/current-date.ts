/**
 * Formats a date for the `CURRENT DATE:` line in the variable tail so the
 * model knows what "today" is. Without it, local models default to their
 * training-era year and hallucinate the timeline (e.g. hardcoding "2025"
 * into a "latest news" search query when it is actually 2026). The line
 * lives in the tail (close to the generation point), not the stable
 * prefix, so it does not touch KV-cache reuse.
 *
 * Uses the host local time zone — "today" is most intuitive for the
 * operator's wall clock.
 */
export function formatCurrentDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return `${year}-${month}-${day} (${weekday})`;
}
