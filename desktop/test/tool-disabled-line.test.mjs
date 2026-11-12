// ATO-1417: a tool the model server refused (its schema) is one line in the transcript, never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('function toolDisabledLine(p)');
const end = renderer.indexOf('\n}\n', start) + 3;
const ctx = createContext({});
runInContext(renderer.slice(start, end) + ';this.line = toolDisabledLine;', ctx);

test("the agent's own sentence is shown as it is", () => {
  assert.equal(ctx.line({ notice: 'Tool notion.search is disabled for this turn: the model server did not accept its schema.', tool: 'notion.search' }),
    'Tool notion.search is disabled for this turn: the model server did not accept its schema.');
});

test('without a notice the tool name still says what is off; nothing to say gives an empty line', () => {
  assert.equal(ctx.line({ tool: 'notion.search', reason: 'schema_rejected' }),
    'Tool notion.search is disabled for this turn: the model server did not accept its schema.');
  assert.equal(ctx.line({}), '');
  assert.equal(ctx.line({ tool: '  ' }), '');
  assert.equal(ctx.line(null), '');
});

test('the frame draws into the turn and is handled by the chat event router', () => {
  assert.match(renderer, /'provider_switched', 'tool_disabled',/);
  assert.match(renderer, /if \(ev\.kind === 'tool_disabled'\) \{/);
});
