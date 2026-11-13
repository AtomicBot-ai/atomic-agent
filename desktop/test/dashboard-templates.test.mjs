// ATO-1138: the window's own chart library (renderer/dashboard-templates.js):
// line, bar, area, pie, table and KPI cards as a whole page for the sandboxed
// artifact frame, from canvas.render's argument shape (ATO-1137) or the
// shorter {type, title, data}. No dependency, no script, every text escaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../renderer/dashboard-templates.js");

const sales = { chart: "bar", title: "Sales", subtitle: "2026", labels: ["Q1", "Q2", "Q3"],
  series: [{ name: "North", values: [10, "1,200", -5] }, { name: "South", values: [3, 4, 5] }] };

test("every canvas.render chart type and cards are known", () => {
  assert.deepEqual(D.DASH_TYPES, ["line", "bar", "area", "pie", "table", "cards"]);
});

test("numbers come from what models send; anything else is a gap", () => {
  assert.equal(D.dashNum(3), 3);
  assert.equal(D.dashNum("1,200"), 1200);
  assert.equal(D.dashNum(" 42% "), 42);
  assert.equal(D.dashNum("-0.5"), -0.5);
  assert.equal(D.dashNum("abc"), null);
  assert.equal(D.dashNum(NaN), null);
  assert.equal(D.dashNum(null), null);
});

test("the axis takes round numbers and always shows zero", () => {
  assert.deepEqual(D.dashScale(0, 87), { lo: 0, hi: 100, step: 20 });
  const s = D.dashScale(-12, 30);
  assert.ok(s.lo <= -12 && s.hi >= 30 && s.lo < 0);
  assert.deepEqual(D.dashScale(5, 5), D.dashScale(0, 5));
  assert.equal(D.dashFmt(12500), "12.5K");
  assert.equal(D.dashFmt(3_400_000), "3.4M");
});

test("canvas.render's args and {type, title, data} describe the same chart", () => {
  const a = D.dashNormalize(sales);
  const b = D.dashNormalize({ type: "bar", title: "Sales", subtitle: "2026", data: { labels: sales.labels, series: sales.series } });
  assert.equal(a.ok, true);
  assert.deepEqual(a, b);
  assert.deepEqual(a.series[0].values, [10, 1200, -5]);
  // One `values` list is one series.
  const one = D.dashNormalize({ chart: "line", labels: ["a", "b"], values: [1, 2] });
  assert.deepEqual(one.series, [{ name: "Value", values: [1, 2] }]);
  // A short series leaves gaps rather than shifting.
  assert.deepEqual(D.dashNormalize({ type: "line", labels: ["a", "b", "c"], values: [1] }).series[0].values, [1, null, null]);
});

test("a spec that cannot be drawn says why, in plain words", () => {
  assert.match(D.dashNormalize({ type: "radar", labels: ["a"], values: [1] }).error, /Unknown chart type/);
  assert.match(D.dashNormalize({ type: "bar", values: [1] }).error, /labels/);
  assert.match(D.dashNormalize({ type: "bar", labels: ["a"] }).error, /series/);
  assert.match(D.dashNormalize({ type: "cards", data: [] }).error, /Cards need/);
  assert.equal(D.dashNormalize(null).ok, false);
  assert.equal(D.dashNormalize([1, 2]).ok, false);
  const page = D.dashboardHtml({ type: "radar" });
  assert.match(page, /class="err">Unknown chart type/);
  assert.match(D.dashboardFromJson("{not json"), /not valid JSON/);
});

test("line, bar, area and pie are inline SVG with a value on hover; no script anywhere", () => {
  for (const type of ["line", "bar", "area", "pie"]) {
    const page = D.dashboardHtml({ ...sales, chart: type });
    assert.match(page, /<svg viewBox="0 0 720 340"/, type);
    assert.match(page, /<title>Q1[ :]/, type);
    assert.doesNotMatch(page, /<script|on\w+=|https?:/i, type);
  }
  assert.match(D.dashboardHtml(sales), /<rect /);
  assert.match(D.dashboardHtml({ ...sales, chart: "line" }), /<path d="M/);
  assert.match(D.dashboardHtml({ ...sales, chart: "area" }), /fill-opacity=".18"/);
  assert.match(D.dashboardHtml({ ...sales, chart: "pie" }), / A\d+ \d+ 0 [01] 1 /);
  // Two series: a legend.
  assert.match(D.dashboardHtml(sales), /class="legend"[\s\S]*North[\s\S]*South/);
  // A pie of nothing above zero says so instead of drawing NaN.
  const empty = D.dashboardHtml({ chart: "pie", labels: ["a"], values: [0] });
  assert.match(empty, /No values above zero/);
  assert.doesNotMatch(empty, /NaN/);
});

test("tables: rows of objects, columns + rows, or labels + series", () => {
  const objs = D.dashboardHtml({ type: "table", title: "T", data: [{ name: "a", n: 1 }, { name: "b", n: 2 }] });
  assert.match(objs, /<th>name<\/th><th>n<\/th>/);
  assert.match(objs, /<td>b<\/td><td class="num">2<\/td>/);
  const cr = D.dashboardHtml({ type: "table", data: { columns: ["x", "y"], rows: [["1", 2]] } });
  assert.match(cr, /<th>x<\/th><th>y<\/th>[\s\S]*<td>1<\/td><td class="num">2<\/td>/);
  const ls = D.dashboardHtml({ ...sales, chart: "table" });
  assert.match(ls, /<th><\/th><th>North<\/th><th>South<\/th>/);
  assert.match(ls, /<td>Q2<\/td><td class="num">1200<\/td>/);
});

test("KPI cards: label, value, a delta coloured by its sign, a note", () => {
  const page = D.dashboardHtml({ type: "cards", title: "This week", data: [
    { label: "Users", value: "1.2K", delta: "+8%" }, { label: "Churn", value: "2.1%", delta: "-0.4%", note: "vs last week" }] });
  assert.match(page, /<div class="kpi-l">Users<\/div><div class="kpi-v">1.2K<\/div><div class="kpi-d up">\+8%<\/div>/);
  assert.match(page, /<div class="kpi-d down">-0.4%<\/div><div class="kpi-n">vs last week<\/div>/);
  assert.match(D.dashboardHtml({ type: "cards", cards: [{ name: "A", value: 1 }] }), /kpi-l">A</);
});

test("every text from the data is escaped", () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const page = D.dashboardHtml({ type: "bar", title: evil, subtitle: evil, labels: [evil], series: [{ name: evil, values: [1] }] });
  assert.doesNotMatch(page, /<img/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  for (const type of ["table", "cards", "pie"]) {
    const p = type === "cards" ? D.dashboardHtml({ type, data: [{ label: evil, value: evil, delta: evil, note: evil }] })
      : D.dashboardHtml({ type, labels: [evil], series: [{ name: evil, values: [1] }] });
    assert.doesNotMatch(p, /<img/, type);
  }
});

test("the page follows the window's theme, and its own scheme when none is given", () => {
  assert.match(D.dashboardHtml(sales, "dark"), /^<html lang="en" data-theme="dark">/);
  assert.match(D.dashboardHtml(sales, "light"), /^<html lang="en" data-theme="light">/);
  assert.match(D.dashboardHtml(sales), /^<html lang="en"><head>/);
  assert.match(D.dashboardHtml(sales), /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme\]\)/);
});

test("numbers too large to draw give the error page instead of freezing", () => {
  const big = /class="err">The numbers are too large to draw/;
  assert.match(D.dashboardHtml({ type: "bar", labels: ["a"], values: [1.7e308] }), big);
  assert.match(D.dashboardHtml({ type: "line", labels: ["a", "b"], values: [-1.7e308, 1.7e308] }), big);
  assert.match(D.dashboardHtml({ type: "area", labels: ["a", "b"], values: [-1.7e308, 5] }), big);
  assert.match(D.dashboardHtml({ type: "pie", labels: ["a", "b"], values: [1.7e308, 1.7e308] }), big);
  assert.equal(D.dashScale(0, 1.7e308), null);
  assert.equal(D.dashScale(-1.7e308, 1.7e308), null);
  assert.equal(D.dashScale(NaN, 1), null);
});

test("NaN, Infinity and their strings are dropped, the chart still draws", () => {
  for (const type of ["bar", "line", "area", "pie"]) {
    const page = D.dashboardHtml({ type, labels: ["a", "b", "c", "d"], values: [NaN, Infinity, -Infinity, "Infinity"] });
    assert.doesNotMatch(page, /NaN|Infinity/, type);
    assert.match(page, /<\/html>$/, type);
  }
  const mixed = D.dashboardHtml({ type: "bar", labels: ["a", "b"], values: [Infinity, 4] });
  assert.doesNotMatch(mixed, /class="err"|NaN/);
});

test("the window loads the templates before the artifact module and renderer.js", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const t = html.indexOf('src="dashboard-templates.js"');
  assert.ok(t > 0 && t < html.indexOf('src="chat-artifact.js"') && t < html.indexOf('src="renderer.js"'));
});
