// Pure helpers for analytics-query.mjs: turn GA4, Search Console and PostHog
// responses into a few compact lines, compare two saved results, and find
// keyword cannibalization. The model sees only a few thousand characters of
// tool output, so full responses are saved to disk and only this goes to
// stdout.

export const SHOW_ROWS = 30;

function round(n, digits = 2) {
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : n;
}

/** GA4 or Search Console rows as `{ key, metrics }`, whatever the source. */
export function toRecords(source, data) {
  if (source === "gsc") {
    return (data.rows ?? []).map((r) => ({
      key: (r.keys ?? []).join(" | "),
      keys: r.keys ?? [],
      metrics: { clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: r.ctr ?? 0, position: r.position ?? 0 },
    }));
  }
  if (source === "ga4") {
    const dims = (data.dimensionHeaders ?? []).map((h) => h.name);
    const mets = (data.metricHeaders ?? []).map((h) => h.name);
    return (data.rows ?? []).map((r) => {
      const keys = (r.dimensionValues ?? []).map((v) => v.value);
      const metrics = {};
      mets.forEach((m, i) => {
        metrics[m] = Number(r.metricValues?.[i]?.value ?? 0);
      });
      return { key: keys.join(" | "), keys, metrics, dims };
    });
  }
  throw new Error(`no records for source ${source}`);
}

function formatMetrics(metrics) {
  return Object.entries(metrics)
    .map(([k, v]) => `${k}=${round(v, k === "ctr" ? 4 : 2)}`)
    .join(" ");
}

/** A compact text summary of one response. */
export function summarize(source, data) {
  const lines = [];
  if (source === "posthog") {
    const results = data.results ?? [];
    lines.push(`columns: ${(data.columns ?? []).join(", ")}`);
    lines.push(`rows: ${results.length}`);
    for (const row of results.slice(0, SHOW_ROWS)) lines.push(JSON.stringify(row));
    if (results.length > SHOW_ROWS) lines.push(`(showing ${SHOW_ROWS} of ${results.length} rows)`);
    return lines.join("\n");
  }
  const records = toRecords(source, data);
  if (source === "ga4") {
    lines.push(`dimensions: ${(data.dimensionHeaders ?? []).map((h) => h.name).join(", ")}`);
    lines.push(`metrics: ${(data.metricHeaders ?? []).map((h) => h.name).join(", ")}`);
    lines.push(`rows: ${data.rowCount ?? records.length}`);
  } else {
    lines.push(`rows: ${records.length}`);
    records.sort((a, b) => b.metrics.clicks - a.metrics.clicks || b.metrics.impressions - a.metrics.impressions);
  }
  for (const r of records.slice(0, SHOW_ROWS)) lines.push(`${r.key}: ${formatMetrics(r.metrics)}`);
  if (records.length > SHOW_ROWS) lines.push(`(showing ${SHOW_ROWS} of ${records.length} rows${source === "gsc" ? ", most clicks first" : ""})`);
  return lines.join("\n");
}

/**
 * Join two saved results (current, previous) by row key and list the
 * biggest changes of one metric. `order`: "abs" (largest change either
 * way), "growth" (largest increase), "drop" (largest decrease).
 */
export function compare(source, current, previous, { metric, order = "abs", minValue = 0, limit = SHOW_ROWS } = {}) {
  const cur = toRecords(source, current);
  const prev = new Map(toRecords(source, previous).map((r) => [r.key, r.metrics]));
  const m = metric ?? (source === "gsc" ? "impressions" : Object.keys(cur[0]?.metrics ?? {})[0]);
  if (!m) return "no rows to compare";
  const seen = new Set();
  const rows = [];
  for (const r of cur) {
    seen.add(r.key);
    const before = prev.get(r.key)?.[m] ?? 0;
    const after = r.metrics[m] ?? 0;
    if (Math.max(before, after) < minValue) continue;
    rows.push({ key: r.key, before, after, delta: after - before, isNew: !prev.has(r.key) });
  }
  for (const [key, metrics] of prev) {
    if (seen.has(key)) continue;
    const before = metrics[m] ?? 0;
    if (before < minValue) continue;
    rows.push({ key, before, after: 0, delta: -before, gone: true });
  }
  const totalBefore = [...prev.values()].reduce((s, x) => s + (x[m] ?? 0), 0);
  const totalAfter = cur.reduce((s, x) => s + (x.metrics[m] ?? 0), 0);
  if (order === "growth") rows.sort((a, b) => b.delta - a.delta);
  else if (order === "drop") rows.sort((a, b) => a.delta - b.delta);
  else rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const lines = [
    `metric: ${m}`,
    `total: previous=${round(totalBefore)} current=${round(totalAfter)} change=${round(totalAfter - totalBefore)}`,
    `rows compared: ${rows.length} (min ${m} ${minValue})`,
  ];
  for (const r of rows.slice(0, limit)) {
    const tag = r.isNew ? " [new]" : r.gone ? " [gone]" : "";
    lines.push(`${r.key}: ${round(r.before)} -> ${round(r.after)} (${r.delta >= 0 ? "+" : ""}${round(r.delta)})${tag}`);
  }
  return lines.join("\n");
}

/**
 * Queries where two or more pages each get at least `minShare` of the
 * query's impressions. Input: a Search Console result with dimensions
 * ["query","page"].
 */
export function cannibalization(data, { minShare = 0.1, minImpressions = 100, limit = SHOW_ROWS } = {}) {
  const byQuery = new Map();
  for (const r of data.rows ?? []) {
    const [query, page] = r.keys ?? [];
    if (query === undefined || page === undefined) {
      throw new Error('cannibalization needs a Search Console result with "dimensions":["query","page"]');
    }
    if (!byQuery.has(query)) byQuery.set(query, []);
    byQuery.get(query).push({ page, clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, position: r.position ?? 0 });
  }
  const flagged = [];
  for (const [query, pages] of byQuery) {
    const total = pages.reduce((s, p) => s + p.impressions, 0);
    if (total < minImpressions) continue;
    const strong = pages.filter((p) => p.impressions / total >= minShare);
    if (strong.length < 2) continue;
    strong.sort((a, b) => b.impressions - a.impressions);
    flagged.push({ query, total, pages: strong });
  }
  flagged.sort((a, b) => b.total - a.total);
  const lines = [
    `queries checked: ${byQuery.size}; flagged: ${flagged.length} (each of 2+ pages has >= ${round(minShare * 100)}% of impressions, query >= ${minImpressions} impressions)`,
  ];
  for (const f of flagged.slice(0, limit)) {
    lines.push(`${f.query} (${f.total} impressions)`);
    for (const p of f.pages) {
      lines.push(`  ${p.page}: impressions=${p.impressions} share=${round((p.impressions / f.total) * 100, 1)}% clicks=${p.clicks} position=${round(p.position, 1)}`);
    }
  }
  if (flagged.length > limit) lines.push(`(showing ${limit} of ${flagged.length} flagged queries)`);
  return lines.join("\n");
}
