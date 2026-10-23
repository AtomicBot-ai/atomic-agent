// ATO-669: the ⌘K palette's ranking. The old exact/prefix/substring order
// stays first; a subsequence match ("mdl" → Models) and a one-typo match
// ("modles") now find rows the old search missed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {fuzzyRank, fuzzyFilter, fuzzyTypoVariants} = createRequire(import.meta.url)('../renderer/fuzzy-match.js');

const SETTINGS = ['General', 'Models', 'MCP servers', 'Telegram', 'Composio', 'Memory', 'Privacy', 'Diagnostics'];
const find = (q) => fuzzyFilter(q, SETTINGS, (t) => t);

test('a subsequence finds the row the old substring search missed', () => {
  assert.equal(find('mdl')[0], 'Models');
  assert.equal(find('prvcy')[0], 'Privacy');
  assert.equal(find('mcp srv')[0], 'MCP servers');
  assert.ok(Number.isFinite(fuzzyRank('mdl', 'Models')));
});

test('a dropped letter, two swapped letters and one letter too many still match', () => {
  assert.equal(find('telgram')[0], 'Telegram');
  assert.equal(find('modles')[0], 'Models');
  assert.equal(find('telegrram')[0], 'Telegram');
});

test('the old tiers keep their order and outrank every fuzzy match', () => {
  assert.equal(fuzzyRank('models', 'Models'), 0);
  assert.equal(fuzzyRank('mod', 'Models'), 1);
  assert.equal(fuzzyRank('serv', 'MCP servers'), 2);
  assert.equal(fuzzyRank('odel', 'Models'), 3);
  assert.equal(fuzzyRank('side', 'Steps', {cx: 'Side panel'}), 4);
  assert.equal(fuzzyRank('llm', 'Models', {sc: '/llm'}), 2);
  assert.equal(fuzzyRank('/llm', 'Models', {sc: '/llm'}), 2);
  const sub = fuzzyRank('mdl', 'Models');
  const typo = fuzzyRank('modles', 'Models');
  assert.ok(sub >= 5 && sub < 6, 'subsequence tier');
  assert.ok(typo >= 6 && typo < 7, 'typo tier');
  // A substring hit stands above a subsequence hit for the same query.
  eqOrder(fuzzyFilter('odel', ['Open a delivery', 'Models'], (t) => t), ['Models', 'Open a delivery']);
  eqOrder(fuzzyFilter('mem', ['Remember me', 'Model memo', 'Memory'], (t) => t), ['Memory', 'Model memo', 'Remember me']);
});

test('ties keep the order the rows came in; a better fuzzy score goes first', () => {
  eqOrder(fuzzyFilter('report', ['Weekly report 1', 'Weekly report 2', 'Weekly report 3'], (t) => t),
    ['Weekly report 1', 'Weekly report 2', 'Weekly report 3']);
  // "dgn" is a tighter subsequence of Diagnostics than of a long title.
  eqOrder(fuzzyFilter('dgn', ['Draft a long design note', 'Diagnostics'], (t) => t), ['Diagnostics', 'Draft a long design note']);
});

test('an empty query keeps every row in its existing order', () => {
  eqOrder(find(''), SETTINGS);
  assert.notEqual(find(''), SETTINGS);   // a copy, so a caller's slice cannot touch the source
});

test('no match is Infinity and is filtered out', () => {
  assert.equal(fuzzyRank('zzzz', 'Models'), Infinity);
  assert.deepEqual(find('qqqq'), []);
});

test('short queries get no typo variants, where a dropped letter would match almost anything', () => {
  assert.deepEqual(fuzzyTypoVariants('tg'), []);
  assert.deepEqual(fuzzyTypoVariants('mdl'), []);
  assert.ok(fuzzyTypoVariants('modles').includes('models'));
  assert.ok(!fuzzyTypoVariants('abcd').some((v) => v.length < 4));   // deletions only from five letters
});

function eqOrder(actual, expected) { assert.deepEqual([...actual], expected); }
