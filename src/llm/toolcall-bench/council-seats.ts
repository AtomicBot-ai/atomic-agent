/**
 * Council seats (ATO-2432): who answers the question. A seat is one
 * model spec (`<provider>` or `<provider>:<model>`), and a seat may be
 * the same model several times: `or:gpt-4o*3` asks it three times at
 * different temperatures. That is Self-MoA (Princeton, 2025): sampling
 * the best model N times and synthesising often beats mixing different
 * models, so the council has to support it, not only a list of models.
 *
 * Pure: the caller resolves specs to providers.
 */

/** Most seats one council may have (Perplexity Computer allows 2 to 8 models). */
export const COUNCIL_MAX_SEATS = 8;

/**
 * Temperatures for a model that sits more than once, by repeat index.
 * The first sample keeps the model's default; later ones are spread so
 * the samples actually differ (Self-MoA samples at temperature > 0).
 */
export const SELF_MOA_TEMPERATURES: readonly (number | undefined)[] = [undefined, 0.7, 1.0, 0.4, 0.9, 0.55, 0.85, 1.1];

export interface CouncilSeat {
  /** Unique seat name shown to people: the spec, or `spec #2` for a repeat. */
  id: string;
  /** The model spec the seat asks. */
  spec: string;
  /** Sampling temperature; absent keeps the model's default. */
  temperature?: number;
}

export type CouncilSeatsResult =
  | { ok: true; seats: CouncilSeat[] }
  | { ok: false; reason: string };

const REPEAT = /^(.*?)\s*\*\s*(\d+)$/;

/**
 * Seats from a `--models` list: comma separated specs, each optionally
 * `*N`. A spec named twice counts as a repeat too. No items at all gives
 * `fallback` three times (the Self-MoA default when nothing is named).
 */
export function parseCouncilSeats(raw: string | undefined, fallback: string): CouncilSeatsResult {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const specs: string[] = [];
  for (const item of items.length === 0 ? [`${fallback}*3`] : items) {
    const repeat = REPEAT.exec(item);
    const spec = (repeat ? repeat[1]! : item).trim();
    const times = repeat ? Number.parseInt(repeat[2]!, 10) : 1;
    if (spec === "") return { ok: false, reason: `"${item}" names no model` };
    if (!Number.isFinite(times) || times < 1) return { ok: false, reason: `"${item}": the count after * must be 1 or more` };
    for (let i = 0; i < times; i += 1) specs.push(spec);
    if (specs.length > COUNCIL_MAX_SEATS) {
      return { ok: false, reason: `a council has at most ${COUNCIL_MAX_SEATS} seats` };
    }
  }
  const total = new Map<string, number>();
  for (const spec of specs) total.set(spec, (total.get(spec) ?? 0) + 1);
  const seen = new Map<string, number>();
  const seats = specs.map((spec): CouncilSeat => {
    const n = seen.get(spec) ?? 0;
    seen.set(spec, n + 1);
    const repeated = (total.get(spec) ?? 1) > 1;
    const temperature = repeated ? SELF_MOA_TEMPERATURES[n % SELF_MOA_TEMPERATURES.length] : undefined;
    return {
      id: repeated ? `${spec} #${n + 1}` : spec,
      spec,
      ...(temperature !== undefined ? { temperature } : {}),
    };
  });
  return { ok: true, seats };
}

/** The distinct specs the seats ask, in first-seen order. */
export function seatSpecs(seats: readonly CouncilSeat[]): string[] {
  return [...new Set(seats.map((s) => s.spec))];
}
