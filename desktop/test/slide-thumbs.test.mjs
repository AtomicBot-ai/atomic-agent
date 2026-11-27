// ATO-2444: a deck's slides as thumbnails under its os.fs.write_pptx card (renderer/slide-thumbs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const T = require('../renderer/slide-thumbs.js');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const frame = (slide) => ({object: 'atomic.tool_update', tool: 'os.fs.write_pptx', fraction: 0.5, label: 'x', slide});
const base = {index: 0, count: 3, layout: 'bullets', title: 'Goals', bullets: ['Ship', '  Beta'], moved: 0, theme: 'dark'};

test('a frame\'s slide is read only when its shape is whole; an older agent sends none', () => {
  assert.deepEqual(T.slideOfUpdate(frame(base)), {index: 0, count: 3, title: 'Goals', layout: 'bullets', subtitle: '', bullets: ['Ship', '  Beta'], visual: '', moved: 0, theme: 'dark', accent: ''});
  assert.equal(T.slideOfUpdate({tool: 'video.generate', fraction: 0.4}), null);
  assert.equal(T.slideOfUpdate(frame({...base, index: 3})), null, 'index past the count');
  assert.equal(T.slideOfUpdate(frame({...base, title: ''})), null);
  assert.equal(T.slideOfUpdate(frame({...base, theme: 'neon'})).theme, 'light');
  assert.equal(T.slideOfUpdate(frame({...base, layout: 'x" onclick="y'})).layout, 'bullets');
  assert.equal(T.slideOfUpdate(frame({...base, accent: 'red;background:url(x)'})).accent, '');
  assert.equal(T.slideOfUpdate(frame({...base, accent: '2F6FEB'})).accent, '#2F6FEB');
});

test('the card keeps each slide by index and draws a strip of them, escaped', () => {
  const card = {k: 'tool', name: 'os.fs.write_pptx', ok: null};
  assert.equal(T.slideThumbsHTML(card, esc), '', 'nothing before the first slide');
  assert.equal(T.slideThumbsAdd(card, {tool: 'video.generate'}), false);
  T.slideThumbsAdd(card, frame({...base, index: 1, title: '<b>Plan</b>', layout: 'timeline', bullets: ['2024: Build', '2025: Ship']}));
  T.slideThumbsAdd(card, frame({...base, index: 0, layout: 'title', subtitle: 'Team'}));
  let html = T.slideThumbsHTML(card, esc);
  assert.match(html, /Laid out 2 of 3 slides/);
  assert.equal((html.match(/class="st-thumb /g) || []).length, 2);
  assert.ok(html.indexOf('st-title') < html.indexOf('st-timeline'), 'in slide order');
  assert.ok(html.includes('&lt;b&gt;Plan&lt;/b&gt;') && !html.includes('<b>Plan'));
  assert.match(html, /--st-bg:#111827/);
  T.slideThumbsAdd(card, frame({...base, index: 2, layout: 'chart', visual: 'chart', moved: 2}));
  card.ok = true;
  html = T.slideThumbsHTML(card, esc);
  assert.match(html, /<div class="st-head tnum" role="status">3 slides<\/div>/);
  assert.match(html, /<div class="st-visual">Chart<\/div>/);
  assert.match(html, /2 points moved to the speaker notes/);
  card.ok = false;
  assert.equal(T.slideThumbsHTML(card, esc), '', 'a failed or denied deck shows no strip');
});

test('a comparison draws both columns: split at its second heading, or at the middle when the frame has none', () => {
  const cols = (bullets) => {
    const card = {k: 'tool', name: 'os.fs.write_pptx', ok: null};
    T.slideThumbsAdd(card, frame({...base, layout: 'comparison', bullets}));
    const m = /<div class="st-row st-cols"><div>(.*?)<\/div><div>(.*?)<\/div><\/div>/.exec(T.slideThumbsHTML(card, esc));
    return m && [m[1], m[2]];
  };
  const [l1, r1] = cols(['Before', '  a', '  b', 'After', '  f']);
  assert.match(l1, /Before/);
  assert.match(r1, /After/);
  const [l2, r2] = cols(['Before', '  a', '  b', '  c', '  d', '  e']);
  assert.match(l2, /Before/);
  assert.notEqual(r2, '', 'the second column is not empty');
});

test('the renderer keeps a tool_update\'s slide and draws the strip on the card; the page loads it first', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const update = src.slice(src.indexOf("if (ev.kind === 'tool_update') {"), src.indexOf("if (ev.kind === 'delta') {"));
  assert.match(update, /if \(typeof slideThumbsAdd === 'function'\) slideThumbsAdd\(card, ev\.payload\);/);
  assert.match(src, /\+ \(running && !m\.slides \? toolProgressHTML\(m, esc\) : ''\)/);
  assert.match(src, /\+ \(typeof slideThumbsHTML === 'function' \? slideThumbsHTML\(m, esc\) : ''\)/);
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('src="slide-thumbs.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  assert.ok(html.includes('href="css/slide-thumbs.css"'));
});
