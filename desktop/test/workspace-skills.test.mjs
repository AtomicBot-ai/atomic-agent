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

// Exercise the renderer's real async actions without booting Electron. These
// regressions concern which session owns the response and whether a catalog
// response replaces the editor, rather than visual DOM details.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url),'utf8');
function actionSource(start, end) { return renderer.slice(renderer.indexOf(start), renderer.indexOf(end, renderer.indexOf(start))); }
function toggleFixture(cloud) {
  const calls = [], state = {key:'A'};
  const context = createContext({
    SK:{workingDir:cloud ? '/A' : null, rows:[{name:'guide',enabled:true,disabledReasons:[]}]},
    SKP:{busy:false,msg:null},
    BR:{skillSetDisabled:async (...args)=>{calls.push(args); return {ok:true};}},
    skillContextKey:()=>state.key, skillSessionId:()=> 'session-A', render:()=>{}, skpReloadRows:async()=>{},
  });
  runInContext(actionSource('async function skpToggle(name, scope)', 'async function skpToggleProject()'),context);
  return {context,calls,state};
}
test('local toggles keep the global setting, original message and restart behavior', async () => {
  const {context,calls} = toggleFixture(false);
  await context.skpToggle('guide');
  assert.deepEqual(calls, [['guide',true,'global','session-A']]);
  assert.equal(context.SKP.msg.text,'skill disabled: guide');
  assert.equal(context.SKP.msg.restart,true);
});
test('cloud workspace enable cannot override a global ban', async () => {
  const {context,calls} = toggleFixture(true);
  context.SK.rows[0] = {name:'guide',enabled:false,disabledReasons:['disabled globally','disabled in workspace']};
  await context.skpToggle('guide');
  assert.deepEqual(calls, [['guide',false,'workspace','session-A']]);
  assert.equal(context.SKP.msg.restart,false);
});
test('a setting response from A cannot clear B pending state or show A message', async () => {
  const {context,state} = toggleFixture(true), hold = deferred();
  context.BR.skillSetDisabled = ()=>hold.promise;
  const action = context.skpToggle('guide');
  state.key = 'B'; context.SKP.operationSeq++; context.SKP.busy = true;
  hold.resolve({ok:true}); await action;
  assert.equal(context.SKP.busy,true); assert.equal(context.SKP.msg,null);
});
test('a catalog answer updates slash suggestions without rebuilding a focused composer', async () => {
  let fullRenders=0, slashRenders=0;
  const context=createContext({
    BR:{skillList:()=>{}}, SK:{for:'A',rows:null,projectSkillsEnabled:true}, SKP:{mode:'list'}, SKILLS:[], LIVE_CAPS:null,
    S:{settings:null,overlay:null,slash:true,draft:'/openspec'},
    SK_LOADER:createSkillCatalogLoader(async()=>({ok:true,workingDir:'/A',rows:[{name:'openspec-explore',enabled:true}]})),
    skillContextKey:()=> 'A', skillSessionId:()=> 'session-A', skillsVisible:()=>false, tkTyping:()=>false, skpTyping:()=>false,
    render:()=>{fullRenders++;}, refreshSlash:()=>{slashRenders++;}, refreshPalette:()=>{}, settingsStatusRepaint:()=>{},
  });
  runInContext(actionSource('async function refreshSkillList()', '/* Everything a Manage tab needs'),context);
  await context.refreshSkillList();
  assert.equal(fullRenders,0); assert.equal(slashRenders,1); assert.equal(context.S.draft,'/openspec');
});

test('default Enable in workspace never adds another ban to a globally disabled skill', async () => {
  const {context,calls} = toggleFixture(true);
  context.SK.rows[0] = {name:'guide',enabled:false,disabledReasons:['disabled globally']};
  await context.skpToggle('guide');
  assert.deepEqual(calls, [['guide',false,'workspace','session-A']]);
});
