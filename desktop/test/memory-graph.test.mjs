import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const G = createRequire(import.meta.url)('../renderer/memory-graph.js');

// ATO-584: the Notes graph. Pure parts: data shaping, layout, view, hit test.

const nodeRows = [
  {id: 1, content: 'Hub note\nsecond line', source: 'agent', consolidated_into: null, degree: 3},
  {id: 2, content: 'Two', source: 'user', consolidated_into: null, degree: 1},
  {id: 3, content: '', source: 'agent', consolidated_into: 9, degree: 1},
  {id: 4, content: 'Four', source: 'agent', consolidated_into: null, degree: 1},
];
const edgeRows = [
  {from_id: 1, to_id: 2, kind: 'RELATES_TO', weight: 0.9},
  {from_id: 2, to_id: 1, kind: 'REFERENCES', weight: 0.5}, // the same pair the other way: drawn once
  {from_id: 1, to_id: 3, kind: 'RELATES_TO', weight: 0.4},
  {from_id: 1, to_id: 1, kind: 'SELF', weight: 1},         // a self loop: not drawn
  {from_id: 4, to_id: 99, kind: 'RELATES_TO', weight: 1},  // an end not drawn: dropped
];

test('a label is the id and the first line, clipped', () => {
  assert.equal(G.memGraphLabel(7, '\n  hello\nworld'), '#7 hello');
  assert.equal(G.memGraphLabel(7, ''), '#7');
  assert.equal(G.memGraphLabel(7, 'x'.repeat(80)).length, '#7 '.length + 60);
});

test('shape keeps drawn pairs once, drops self loops and loose ends, counts degree', () => {
  const st = G.memGraphShape(nodeRows, edgeRows, 300);
  assert.deepEqual(st.nodes.map((n) => n.id), [1, 2, 3, 4]);
  assert.deepEqual(st.edges.map((e) => [e.s, e.t, e.kind]), [[0, 1, 'RELATES_TO'], [0, 2, 'RELATES_TO']]);
  assert.deepEqual(st.nodes.map((n) => n.degree), [2, 1, 1, 0]);
  assert.equal(st.nodes[2].archived, true);
  assert.equal(st.nodes[0].archived, false);
});

test('shape caps the node count, in the order the statement gave (most linked first)', () => {
  const st = G.memGraphShape(nodeRows, edgeRows, 2);
  assert.deepEqual(st.nodes.map((n) => n.id), [1, 2]);
  assert.equal(st.edges.length, 1);
  assert.equal(G.MEMGRAPH_MAX_NODES, 300);
});

test('a reload keeps the places of notes already drawn, and starts calmer', () => {
  const a = G.memGraphShape(nodeRows, edgeRows, 300);
  a.nodes[1].x = 123; a.nodes[1].y = -45;
  const b = G.memGraphShape(nodeRows.slice(1), edgeRows, 300, a);
  assert.equal(b.nodes[0].id, 2);
  assert.deepEqual([b.nodes[0].x, b.nodes[0].y], [123, -45]);
  assert.ok(b.alpha < a.alpha);
});

test('seed positions are spread and the same every time', () => {
  assert.deepEqual(G.memGraphSeed(5), G.memGraphSeed(5));
  const seen = new Set(Array.from({length: 50}, (_, i) => { const p = G.memGraphSeed(i); return Math.round(p.x) + ',' + Math.round(p.y); }));
  assert.equal(seen.size, 50);
});

test('the layout settles: linked notes end closer than unlinked ones, nothing is NaN', () => {
  const rows = Array.from({length: 12}, (_, i) => ({id: i + 1, content: 'n' + i}));
  const links = [{from_id: 1, to_id: 2}, {from_id: 2, to_id: 3}, {from_id: 1, to_id: 3}];
  const st = G.memGraphShape(rows, links, 300);
  const steps = G.memGraphSettle(st, 2000);
  assert.ok(steps < 2000, 'it comes to rest');
  assert.ok(st.alpha < G.MEMGRAPH_FORCE.minAlpha);
  for (const n of st.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  const d = (a, b) => Math.hypot(st.nodes[a].x - st.nodes[b].x, st.nodes[a].y - st.nodes[b].y);
  const linked = (d(0, 1) + d(1, 2) + d(0, 2)) / 3;
  let far = 0, n = 0;
  for (let i = 3; i < 12; i++) for (let j = i + 1; j < 12; j++) { far += d(i, j); n++; }
  assert.ok(linked < far / n, `linked ${linked.toFixed(1)} < unlinked ${(far / n).toFixed(1)}`);
});

test('two notes on one spot are pushed apart', () => {
  const st = {nodes: [{x: 0, y: 0, vx: 0, vy: 0, degree: 0}, {x: 0, y: 0, vx: 0, vy: 0, degree: 0}], edges: [], alpha: 1};
  G.memGraphStep(st);
  assert.ok(Math.hypot(st.nodes[0].x - st.nodes[1].x, st.nodes[0].y - st.nodes[1].y) > 0);
});

test('fit puts every node inside the box', () => {
  const nodes = [{x: -100, y: 0}, {x: 300, y: 50}, {x: 20, y: -80}];
  const v = G.memGraphFit(nodes, 400, 300);
  for (const n of nodes) {
    const p = G.memGraphToScreen(v, 400, 300, n.x, n.y);
    assert.ok(p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 300, JSON.stringify(p));
  }
  assert.deepEqual(G.memGraphFit([], 400, 300), {x: 0, y: 0, k: 1});
});

test('screen and world convert both ways; zoom keeps the point under the pointer', () => {
  const v = {x: 10, y: -20, k: 1.5};
  const w = G.memGraphToWorld(v, 400, 300, 123, 77);
  const s = G.memGraphToScreen(v, 400, 300, w.x, w.y);
  assert.ok(Math.abs(s.x - 123) < 1e-9 && Math.abs(s.y - 77) < 1e-9);
  const z = G.memGraphZoomAt(v, 400, 300, 123, 77, 2);
  assert.equal(z.k, 3);
  const after = G.memGraphToScreen(z, 400, 300, w.x, w.y);
  assert.ok(Math.abs(after.x - 123) < 1e-9 && Math.abs(after.y - 77) < 1e-9);
  assert.equal(G.memGraphZoomAt(v, 400, 300, 0, 0, 1000).k, 8);
  assert.equal(G.memGraphZoomAt(v, 400, 300, 0, 0, 0.0001).k, 0.1);
});

test('hit finds the dot under the pointer, -1 on empty space', () => {
  const nodes = [{x: 0, y: 0, degree: 0}, {x: 100, y: 0, degree: 4}];
  const v = {x: 0, y: 0, k: 1};
  assert.equal(G.memGraphHit(nodes, v, 400, 300, 200, 150), 0);
  assert.equal(G.memGraphHit(nodes, v, 400, 300, 302, 151), 1);
  assert.equal(G.memGraphHit(nodes, v, 400, 300, 250, 250), -1);
});

test('under the graph the hidden list does not take its keys; the tab keys still work', () => {
  for (const k of ['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter']) assert.equal(G.memGraphListKey(k), true, k);
  for (const k of ['r', 'a', 'f', '[', ']', '1', 'Escape']) assert.equal(G.memGraphListKey(k), false, k);
});
