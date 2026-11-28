/**
 * ATO-2442: Settings > Usage asks the agent for its usage report
 * (GET /api/usage, src/http/route-usage.ts). This file is the pure part:
 * the query the window may send, and the words a failure is shown in.
 * The window never sees an HTTP code or a raw error; the raw text goes
 * behind its "Details".
 */

export type UsageDays = number | "all";

export interface UsageQuery {
  days: UsageDays;
  compare: string | null;
}

export type UsageAnswer =
  | { ok: true; data: unknown }
  | { ok: false; error: string; detail: string; unsupported: boolean };

const MAX_DAYS = 400;
const MAX_COMPARE = 200;

/** The window's ask, checked: whole days 1 to 400 or "all", and a short model name. `null` for anything else. */
export function cleanUsageQuery(payload: unknown): UsageQuery | null {
  const p = payload && typeof payload === "object" ? (payload as { days?: unknown; compare?: unknown }) : {};
  const days = p.days === undefined ? 7 : p.days;
  if (days !== "all" && !(typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) return null;
  let compare: string | null = null;
  if (p.compare !== undefined && p.compare !== null && p.compare !== "") {
    if (typeof p.compare !== "string") return null;
    const trimmed = p.compare.trim();
    if (trimmed.length > MAX_COMPARE || [...trimmed].some((ch) => ch.charCodeAt(0) < 32)) return null;
    compare = trimmed || null;
  }
  return { days, compare };
}

/** `?days=30&compare=deepseek%2Fdeepseek-v4-flash`. */
export function usageQueryString(q: UsageQuery): string {
  const params = new URLSearchParams({ days: String(q.days) });
  if (q.compare) params.set("compare", q.compare);
  return `?${params.toString()}`;
}

/** An agent from before the route answers 404; the window then says to update it. */
export function usageUnsupported(message: string): boolean {
  return /\bHTTP 404\b|\bno route\b/i.test(message);
}

export async function usageCall(fn: () => Promise<unknown>): Promise<UsageAnswer> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const unsupported = usageUnsupported(detail);
    return {
      ok: false,
      unsupported,
      detail,
      error: unsupported
        ? "This version of the agent does not keep a usage report yet. Update the agent to see it."
        : "Could not read usage from the agent. It may still be starting; try again in a moment.",
    };
  }
}
