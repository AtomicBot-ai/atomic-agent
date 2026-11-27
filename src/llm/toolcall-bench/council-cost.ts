/**
 * What a council can cost, said before it runs (ATO-2432). Perplexity
 * notes the price grows with the number of models; here the person sees
 * the number of calls and an upper bound in dollars first, and a
 * `--max-usd` ceiling stops the council before any seat is asked.
 *
 * An upper bound, not a guess: every answer is counted at its full output
 * bound and every prompt that quotes answers at that size too. Local
 * seats cost nothing; a seat whose price is unknown is listed so the
 * bound does not pretend to cover it.
 *
 * Pure: the caller looks the prices up.
 */

import type { CouncilSeat } from "./council-seats.js";
import { COUNCIL_MIN_MEMBERS_TO_RANK } from "./council-rank.js";
import {
  COUNCIL_ANSWER_MAX_TOKENS,
  COUNCIL_CHAIRMAN_MAX_TOKENS,
  COUNCIL_JUDGE_MAX_TOKENS,
  COUNCIL_RANK_MAX_TOKENS,
} from "./run-council.js";

/** Per million tokens, as the model catalogs give it. */
export interface CouncilPricing {
  input: number;
  output: number;
}

/** How a spec is billed. */
export type CouncilPrice =
  | { kind: "free" }
  | { kind: "priced"; pricing: CouncilPricing }
  | { kind: "unknown" };

export interface CouncilCostForecast {
  /** Requests the council makes at most. */
  calls: number;
  /** Upper bound over the priced specs, in USD. */
  maxUsd: number;
  /** Specs that run locally or on a plan and add nothing. */
  free: string[];
  /** Specs with no known price; the bound does not cover them. */
  unpriced: string[];
}

/** Rough characters per token of English text. */
const CHARS_PER_TOKEN = 4;
/** Instruction text around a prompt, in tokens. */
const FRAME_TOKENS = 400;

function usd(tokensIn: number, tokensOut: number, pricing: CouncilPricing): number {
  return (tokensIn / 1_000_000) * pricing.input + (tokensOut / 1_000_000) * pricing.output;
}

export function forecastCouncilCost(options: {
  question: string;
  seats: readonly CouncilSeat[];
  judge: string;
  chairman: string | null;
  rank: boolean;
  priceOf: (spec: string) => CouncilPrice;
}): CouncilCostForecast {
  const n = options.seats.length;
  const q = Math.ceil(options.question.length / CHARS_PER_TOKEN);
  const answers = (count: number) => count * COUNCIL_ANSWER_MAX_TOKENS;
  const requests: Array<{ spec: string; tokensIn: number; tokensOut: number }> = [];
  for (const seat of options.seats) {
    requests.push({ spec: seat.spec, tokensIn: q + FRAME_TOKENS, tokensOut: COUNCIL_ANSWER_MAX_TOKENS });
  }
  if (n >= 2) {
    requests.push({ spec: options.judge, tokensIn: q + answers(n) + FRAME_TOKENS, tokensOut: COUNCIL_JUDGE_MAX_TOKENS });
  }
  if (options.rank && n >= COUNCIL_MIN_MEMBERS_TO_RANK) {
    for (const seat of options.seats) {
      requests.push({ spec: seat.spec, tokensIn: q + answers(n - 1) + FRAME_TOKENS, tokensOut: COUNCIL_RANK_MAX_TOKENS });
    }
  }
  if (n >= 2 && options.chairman !== null) {
    requests.push({
      spec: options.chairman,
      tokensIn: q + answers(n) + COUNCIL_JUDGE_MAX_TOKENS + FRAME_TOKENS,
      tokensOut: COUNCIL_CHAIRMAN_MAX_TOKENS,
    });
  }
  const free = new Set<string>();
  const unpriced = new Set<string>();
  let maxUsd = 0;
  for (const r of requests) {
    const price = options.priceOf(r.spec);
    if (price.kind === "free") free.add(r.spec);
    else if (price.kind === "unknown") unpriced.add(r.spec);
    else maxUsd += usd(r.tokensIn, r.tokensOut, price.pricing);
  }
  return { calls: requests.length, maxUsd, free: [...free], unpriced: [...unpriced] };
}

/** `$0.04`, or four decimals under a cent. */
function dollars(value: number): string {
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** One line for the person: `Up to 9 requests, at most $0.12 (local: x; price unknown: y)`. */
export function describeCouncilCost(forecast: CouncilCostForecast): string {
  const parts = [`Up to ${forecast.calls} requests, at most ${dollars(forecast.maxUsd)}`];
  const extra: string[] = [];
  if (forecast.free.length > 0) extra.push(`free: ${forecast.free.join(", ")}`);
  if (forecast.unpriced.length > 0) extra.push(`price unknown: ${forecast.unpriced.join(", ")}`);
  if (extra.length > 0) parts.push(` (${extra.join("; ")})`);
  return parts.join("");
}

/**
 * Why the council must not start under `maxUsd`, or null. A seat with no
 * known price cannot be held to a limit, so with a limit set it refuses
 * too (local and plan-billed seats are free, never "unpriced"). Both
 * reasons end the same way, so every client shows them as they are.
 */
export function councilOverBudget(forecast: CouncilCostForecast, maxUsd: number | undefined): string | null {
  if (maxUsd === undefined) return null;
  if (forecast.unpriced.length > 0) {
    const seats = forecast.unpriced.join(", ");
    const verb = forecast.unpriced.length === 1 ? "is" : "are";
    return `the price of ${seats} ${verb} unknown, so this council cannot be kept under the ${dollars(maxUsd)} limit; nothing was sent`;
  }
  if (forecast.maxUsd <= maxUsd) return null;
  return `this council could cost up to ${dollars(forecast.maxUsd)}, over the ${dollars(maxUsd)} limit; nothing was sent`;
}
