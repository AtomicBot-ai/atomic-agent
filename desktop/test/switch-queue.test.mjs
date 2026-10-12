import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {createSwitchQueue} = createRequire(import.meta.url)('../renderer/switch-queue.js');
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
test('rapid choices load only the running model and final target, with no unlocked gap', async () => {
  const states=[], calls=[], hold=deferred();
  const q=createSwitchQueue(s=>states.push(s));
  const a=q.submit('route','Loading A',{backend:'local',model:'A'},async()=>{calls.push('A');return hold.promise;});
  const b=q.submit('route','Loading B',{backend:'local',model:'B'},async()=>{calls.push('B');return {ok:true};});
  const c=q.submit('route','Loading C',{backend:'local',model:'C'},async()=>{calls.push('C');return {ok:true};});
  assert.equal(q.snapshot().want.model,'C');
  assert.equal((await b).superseded,true);
  hold.resolve({ok:true});
  assert.equal((await a).superseded,true);
  assert.equal((await c).ok,true);
  assert.deepEqual(calls,['A','C']);
  assert.ok(states.slice(0,-1).every(s=>s.pending===1));
  assert.deepEqual(q.snapshot(),{pending:0,want:null,label:''});
});
test('a coding mode choice survives a model change and holds dispatch through confirmation', async () => {
  const hold=deferred(), mode=deferred(), states=[];
  const q=createSwitchQueue(s=>states.push(s));
  const a=q.submit('route','Loading A',{backend:'local',model:'A'},()=>hold.promise);
  const m=q.submit('mode','Plan',{mode:'plan',route:false},()=>mode.promise);
  assert.deepEqual(q.snapshot().want,{backend:'local',model:'A',mode:'plan'});
  hold.resolve({ok:true}); await a;
  assert.equal(q.snapshot().pending,1);
  assert.notEqual(q.snapshot().want.route,false);
  mode.resolve({ok:true,mode:'plan'}); await m;
  assert.equal(q.snapshot().pending,0);
});
test('an obsolete failure neither rejects nor prevents the next choice', async () => {
  const hold=deferred(); const q=createSwitchQueue(()=>{});
  const a=q.submit('route','A',{model:'A'},async()=>{await hold.promise;throw Error('stale');});
  const b=q.submit('route','B',{model:'B'},async()=>({ok:true}));
  hold.resolve(); assert.equal((await a).superseded,true); assert.equal((await b).ok,true);
});
test('the final failure is reported and a later retry still works', async () => {
  const q=createSwitchQueue(()=>{});
  await assert.rejects(q.submit('route','A',{model:'A'},async()=>{throw Error('load failed');}),/load failed/);
  assert.equal(q.snapshot().pending,0);
  assert.equal((await q.submit('route','A',{model:'A'},async()=>({ok:true}))).ok,true);
});
