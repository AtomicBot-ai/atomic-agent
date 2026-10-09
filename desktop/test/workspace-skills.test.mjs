import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {workspaceSkillCommands, workspaceSkillMessage, createSkillCatalogLoader} = createRequire(import.meta.url)('../renderer/workspace-skills.js');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {resolve, promise}; }

test('commands offer enabled skills once, preserving builtins and their aliases', () => {
  const row = (name, enabled = true) => ({name, enabled, description:'Explore the project'});
  assert.deepEqual(workspaceSkillCommands([
    row('openspec-explore'), row('openspec-explore'), row('off', false), row('help'), row('setup'), row('bad/name'),
  ], [['help','Help'], ['onboarding','Setup','',['setup']]]), [['openspec-explore','Explore the project','skill']]);
  assert.equal(workspaceSkillMessage('openspec-explore', 'look at @file\nthen explain'),
    'Use the "openspec-explore" skill. Load its instructions with skill.view({"name":"openspec-explore"}) before proceeding.\n\nlook at @file\nthen explain');
});

test('late A response cannot replace B, including an A → B → A switch', async () => {
  const a = deferred(), b = deferred(), nextA = deferred(), calls = [];
  const loader = createSkillCatalogLoader(id => { calls.push(id); return [a,b,nextA][calls.length-1].promise; });
  const first = loader.load('generation1/A','A');
  assert.equal(loader.load('generation1/A','A'), first);
  await Promise.resolve();
  const second = loader.load('generation1/B','B'); await Promise.resolve();
  const third = loader.load('generation1/A','A'); await Promise.resolve();
  nextA.resolve({ok:true, rows:[{name:'new-A'}]});
  assert.equal((await third).current, true);
  b.resolve({ok:true, rows:[{name:'B'}]}); a.resolve({ok:true, rows:[{name:'old-A'}]});
  assert.equal((await second).current, false); assert.equal((await first).current, false);
  assert.deepEqual(calls, ['A','B','A']);
});

test('a new request rechecks policy; errors fail closed and remain retryable', async () => {
  let enabled = true, fail = false;
  const loader = createSkillCatalogLoader(async () => {
    if (fail) throw Error('workspace unavailable');
    return {ok:true, rows:[{name:'guide', enabled, description:'Guide'}]};
  });
  assert.equal(workspaceSkillCommands((await loader.load('A','A')).result.rows, []).length, 1);
  enabled = false;
  assert.equal(workspaceSkillCommands((await loader.load('A','A')).result.rows, []).length, 0);
  fail = true; assert.equal((await loader.load('A','A')).result.ok, false);
  fail = false; assert.equal((await loader.load('A','A')).result.ok, true);
});
