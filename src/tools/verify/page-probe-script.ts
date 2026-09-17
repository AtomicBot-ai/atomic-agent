/**
 * What the page runner injects and how it samples.
 *
 * The init script wraps `getElementById` / `querySelector` so a lookup
 * that returned `null` is recorded — dead buttons behind mismatched ids
 * were the runtime failure no static check could see, and the page
 * itself never reports them (a `null.addEventListener` throws, a
 * guarded `if (el)` just does nothing).
 */

export const MISSING_SELECTOR_GLOBAL = "__atagMissingSelectors";
export const MISSING_SELECTOR_CAP = 100;

export const MISSING_SELECTOR_INIT_SCRIPT = `(() => {
  const missing = [];
  window[${JSON.stringify(MISSING_SELECTOR_GLOBAL)}] = missing;
  const record = (kind, selector) => {
    const key = kind + " " + String(selector);
    if (missing.length < ${MISSING_SELECTOR_CAP} && !missing.includes(key)) missing.push(key);
  };
  const byId = Document.prototype.getElementById;
  Document.prototype.getElementById = function (id) {
    const found = byId.call(this, id);
    if (found === null) record("#", id);
    return found;
  };
  for (const proto of [Document.prototype, Element.prototype, DocumentFragment.prototype]) {
    const query = proto.querySelector;
    proto.querySelector = function (selector) {
      const found = query.call(this, selector);
      if (found === null) record("querySelector", selector);
      return found;
    };
  }
})();`;

export const PROBE_INTERVAL_MS = 250;
export const PROBE_MAX_SAMPLES = 40;

export type ProbeSample = readonly [number, unknown];

/** At most `max` samples, evenly spaced, first and last always kept. */
export function downsample(
  samples: readonly ProbeSample[],
  max = PROBE_MAX_SAMPLES,
): ProbeSample[] {
  if (samples.length <= max) return [...samples];
  const out: ProbeSample[] = [];
  const last = samples.length - 1;
  for (let i = 0; i < max; i += 1) {
    out.push(samples[Math.round((i * last) / (max - 1))]!);
  }
  return out;
}

/** Make a sampled value safe to carry in a tool result. */
export function normaliseProbeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 197)}…` : value;
  }
  if (typeof value === "string" && value.length > 200) return `${value.slice(0, 197)}…`;
  return value;
}

/** Evaluate every probe through `evaluate` every 250 ms for `seconds`. */
export async function sampleProbes(
  probes: readonly { name: string; expr: string }[],
  seconds: number,
  evaluate: (expr: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<Record<string, ProbeSample[]>> {
  const raw: Record<string, ProbeSample[]> = {};
  for (const probe of probes) raw[probe.name] = [];
  if (probes.length === 0) return raw;
  const started = Date.now();
  const budget = seconds * 1_000;
  for (;;) {
    const t = Date.now() - started;
    if (t > budget || signal?.aborted) break;
    for (const probe of probes) {
      let value: unknown;
      try {
        value = normaliseProbeValue(await evaluate(probe.expr));
      } catch (err) {
        value = { error: err instanceof Error ? err.message : String(err) };
      }
      raw[probe.name]!.push([t, value]);
    }
    const next = PROBE_INTERVAL_MS - ((Date.now() - started) % PROBE_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, next));
  }
  const out: Record<string, ProbeSample[]> = {};
  for (const [name, samples] of Object.entries(raw)) out[name] = downsample(samples);
  return out;
}
