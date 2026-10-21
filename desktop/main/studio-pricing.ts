/**
 * Studio: the approximate price shown on the Generate button for an
 * OpenRouter model, or nothing.
 *
 * Where the numbers are (checked against the live API on 2026-10-21):
 *   - `GET /api/v1/models` has no per-image or per-clip price: image models
 *     list `image_output` per output TOKEN, and video models are absent.
 *     It is not used.
 *   - Images: `GET /api/v1/images/models/<id>/endpoints` →
 *     `endpoints[].pricing[]` of `{billable, unit, cost_usd, variant?}`.
 *     Only `billable: "output_image"` with `unit: "image"` is a price per
 *     picture; `variant` is the resolution tier (`1k`, `2k`, `768`, …).
 *     A model billed per token (`unit: "token"`) gets no number.
 *   - Video: `GET /api/v1/videos/models` → `data[].pricing_skus`, a map of
 *     SKU name → decimal string. Names starting `cents_per_` are cents;
 *     the `duration_seconds…` family is read as US dollars per second (the
 *     only unit that makes Veo/Kling's 0.08–0.30 plausible). `video_tokens`,
 *     megapixel and reference SKUs get no number.
 *
 * Several providers behind one model may bill differently: the answer is
 * then a range (`usd` the lowest, `maxUsd` the highest). Nothing is ever
 * invented: no match → null. Answers are cached for 24 hours.
 */

export interface StudioPrice {
  /** For the whole request (all images, the whole clip), in US dollars. */
  usd: number;
  /** Set when providers or options disagree: the price is between `usd` and `maxUsd`. */
  maxUsd: number | null;
  /** What the number was made of, for a tooltip: `0.048 USD per image × 2`. */
  basis: string;
}

export interface StudioPriceParams {
  kind: "image" | "video";
  count?: number;
  resolution?: string;
  durationSecs?: number;
  audio?: boolean;
  mode?: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const tier = (s: string | undefined): string | null => (s ? s.trim().toLowerCase() : null);
const round = (n: number): number => Math.round(n * 10_000) / 10_000;

function span(values: number[], basis: string): StudioPrice | null {
  const ok = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (!ok.length) return null;
  const lo = round(Math.min(...ok));
  const hi = round(Math.max(...ok));
  return { usd: lo, maxUsd: hi > lo ? hi : null, basis };
}

/** Per-image price from an `/images/models/<id>/endpoints` answer. */
export function imagePriceFromEndpoints(answer: unknown, params: StudioPriceParams): StudioPrice | null {
  const endpoints = obj(answer)?.endpoints ?? obj(obj(answer)?.data)?.endpoints;
  if (!Array.isArray(endpoints)) return null;
  const want = tier(params.resolution);
  const count = Math.max(1, Math.floor(params.count ?? 1));
  const perImage: number[] = [];
  for (const endpoint of endpoints) {
    const lines = obj(endpoint)?.pricing;
    if (!Array.isArray(lines)) continue;
    const outputs = lines.map(obj).filter((l): l is Obj => !!l && l.billable === "output_image" && l.unit === "image" && typeof l.cost_usd === "number");
    if (!outputs.length) continue;
    const exact = want ? outputs.filter((l) => tier(String(l.variant ?? "")) === want) : [];
    const flat = outputs.filter((l) => l.variant === undefined || l.variant === null);
    // A tier asked for and listed: that one. No tier, or not listed: an untiered line, else every tier (a range).
    const chosen = exact.length ? exact : flat.length ? flat : outputs;
    for (const l of chosen) perImage.push(l.cost_usd as number);
  }
  const price = span(perImage, `${perImage.length ? round(Math.min(...perImage)) : 0} USD per image${count > 1 ? ` × ${count}` : ""}`);
  return price ? { ...price, usd: round(price.usd * count), maxUsd: price.maxUsd === null ? null : round(price.maxUsd * count) } : null;
}

/**
 * Per-second rate candidates for one clip, most specific first. Returns
 * the dollar rates of the first group that matched any SKU.
 */
function videoRates(skus: Obj, params: StudioPriceParams): number[] {
  const res = tier(params.resolution);
  const rate = (name: string): number | null => {
    const raw = skus[name];
    const v = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(v)) return null;
    return name.startsWith("cents_per_") ? v / 100 : v;
  };
  const audioNames = (base: string): string[] =>
    params.audio === true ? [`${base}_with_audio`] : params.audio === false ? [`${base}_without_audio`] : [`${base}_with_audio`, `${base}_without_audio`];
  const workflow = params.mode === "image-to-video" ? "image_to_video" : "text_to_video";
  const groups: string[][] = [];
  if (res) {
    groups.push([`${workflow}_duration_seconds_${res}`]);
    groups.push(audioNames("duration_seconds").map((b) => `${b}_${res}`));
    groups.push([`duration_seconds_${res}`]);
    groups.push([`cents_per_video_output_second_${res}`, `cents_per_second_output_${res}`]);
  }
  groups.push(audioNames("duration_seconds"));
  groups.push(["duration_seconds"]);
  groups.push(["cents_per_second_output"]);
  for (const names of groups) {
    const found = names.map(rate).filter((v): v is number => v !== null);
    if (found.length) return found;
  }
  return [];
}

/** Clip price from one `/videos/models` entry's `pricing_skus`. Needs a duration. */
export function videoPriceFromSkus(skusRaw: unknown, params: StudioPriceParams): StudioPrice | null {
  const skus = obj(skusRaw);
  const seconds = params.durationSecs;
  if (!skus || typeof seconds !== "number" || !(seconds > 0)) return null;
  const rates = videoRates(skus, params);
  if (!rates.length) return null;
  const floorRaw = skus.minimum_cents_per_generation;
  const floor = typeof floorRaw === "string" && Number.isFinite(Number(floorRaw)) ? Number(floorRaw) / 100 : 0;
  const totals = rates.map((r) => Math.max(floor, r * seconds));
  return span(totals, `${round(Math.min(...rates))} USD per second × ${seconds} s`);
}

/* --------------------------------------------------------------- fetching */

export const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const OPENROUTER = "https://openrouter.ai/api/v1";

interface Cached { at: number; value: unknown }

/** Fetches and caches OpenRouter's pricing answers; `price` never throws. */
export class StudioPricing {
  private readonly cache = new Map<string, Cached>();
  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async get(url: string): Promise<unknown> {
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < PRICING_TTL_MS) return hit.value;
    const response = await this.request(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`OpenRouter answered ${response.status}`);
    const value = (await response.json()) as unknown;
    this.cache.set(url, { at: this.now(), value });
    return value;
  }

  async price(modelId: string, params: StudioPriceParams): Promise<StudioPrice | null> {
    if (!/^[\w.-]+\/[\w.:-]+$/.test(modelId)) return null;
    try {
      if (params.kind === "image") {
        const answer = await this.get(`${OPENROUTER}/images/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`);
        return imagePriceFromEndpoints(answer, params);
      }
      const list = obj(await this.get(`${OPENROUTER}/videos/models`))?.data;
      const entry = Array.isArray(list) ? list.map(obj).find((m) => m?.id === modelId) : undefined;
      return entry ? videoPriceFromSkus(entry.pricing_skus, params) : null;
    } catch {
      return null;
    }
  }
}
