import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planEnterFusion } = require('../out/main/run-mode.js');
const source = readFileSync(new URL('../renderer/composer-engines.js', import.meta.url), 'utf8');
function fixture(engine = 'atomic-core') {
  const rm = {orchestratorProviderId:'cloud', workerProviderId:'local-llama'};
  const context = {llmManaged:()=>({engine}), rmNow:()=>rm,
    selProviders:()=>[{id:'cloud'},{id:'second'}], BSW:{readyIds:['cloud','second']},
    selBackend:()=> 'fusion', SEL:{kind:'workers',models:[{id:'remote-model'}],filter:''},
    fzSeats:()=>({plans:{provider:rm.orchestratorProviderId,label:'remote-model'},works:{provider:rm.workerProviderId,label:'local-model'}}),
    selLocalMatches:()=>[{id:'local-model',downloaded:true},{id:'missing',downloaded:false}], llmModelName:m=>m.id,
    modelMatches:()=>true};
  runInNewContext(source,context);
  return {context,rm};
}
test('the local seat is one neutral row, with no engine named',()=>{
  const {context:c}=fixture(); const rows=c.composerLocalEngineRows();
  // The engine is not a choice in the composer: one row, the configured engine, never "Atomic Chat".
  assert.equal(rows.length,1); assert.equal(rows[0].label,'This computer'); assert.equal(rows[0].id,'atomic-core');
  assert.equal(rows[0].detail,'Local model \u00b7 runs on this machine'); assert.equal(rows[0].active,true);
  assert.equal(c.composerEngineName(),'This computer');
});
test('Fusion engine and model menus are separate, with catalogs scoped to each role',()=>{
  const {context:c,rm}=fixture();
  assert.equal(c.composerFusionEngineRows('worker').filter(r=>r.type==='localEngine').length,1);
  assert.equal(c.composerFusionEngineRows('orchestrator').some(r=>r.type==='localEngine'),false);
  let rows=c.composerSeatModelRows().filter(r=>r.type!=='action');
  assert.equal(rows.length,1); assert.equal(rows[0].id,'local-model'); assert.equal(rows[0].leg,'worker');
  rm.workerProviderId='second'; rows=c.composerSeatModelRows();
  assert.equal(rows[0].id,'remote-model'); assert.equal(rows[0].leg,'worker');
  c.SEL.kind='model'; assert.equal(c.composerSeatModelRows()[0].leg,'orchestrator');
});
test('changing a worker keeps a local orchestrator and drops only the obsolete role model pin',()=>{
  const cfg={llm:{activeTextProvider:'local-llama',providers:[{id:'local-llama',kind:'llama-server'},{id:'cloud',kind:'openai-compatible'},{id:'second',kind:'openai-compatible'}],
    runMode:{mode:'fusion',fusion:{orchestratorProvider:'local-llama',orchestratorModel:'local-model',workerProvider:'cloud',workerModel:'old-cloud-model'}}}};
  const result=planEnterFusion(cfg,{workerProvider:'second'},()=>true);
  assert.equal(result.write,true); assert.equal(cfg.llm.activeTextProvider,'local-llama');
  assert.equal(cfg.llm.runMode.fusion.orchestratorModel,'local-model');
  assert.equal(cfg.llm.runMode.fusion.workerProvider,'second'); assert.equal(cfg.llm.runMode.fusion.workerModel,undefined);
});
test('each seat lists every cloud provider, the other seat\'s too, and the local row only while the slot is free',()=>{
  const {context:c,rm}=fixture();
  assert.deepEqual(c.composerFusionEngineRows('orchestrator').filter(r=>r.type==='fusionLeg').map(r=>r.id),['cloud','second']);
  rm.workerProviderId='cloud';
  const worker=c.composerFusionEngineRows('worker');
  assert.deepEqual(worker.filter(r=>r.type==='fusionLeg').map(r=>[r.id,r.active]),[['cloud',true],['second',false]]);
  assert.equal(worker.filter(r=>r.type==='localEngine').length,1);
});
test('two cloud seats may share a provider; both seats on the one local slot are refused',()=>{
  const providers=[{id:'local-llama',kind:'llama-server'},{id:'cloud',kind:'openai-compatible'},{id:'second',kind:'openai-compatible'}];
  const shared={llm:{activeTextProvider:'cloud',providers:JSON.parse(JSON.stringify(providers)),runMode:{mode:'fusion',fusion:{orchestratorProvider:'cloud',workerProvider:'second'}}}};
  const same=planEnterFusion(shared,{orchestratorProvider:'cloud',workerProvider:'cloud'},()=>true);
  assert.equal(same.refusal,undefined); assert.equal(same.write,true);
  assert.equal(shared.llm.runMode.fusion.orchestratorProvider,'cloud'); assert.equal(shared.llm.runMode.fusion.workerProvider,'cloud');
  const local={llm:{activeTextProvider:'local-llama',providers:JSON.parse(JSON.stringify(providers)),runMode:{mode:'fusion',fusion:{orchestratorProvider:'local-llama',workerProvider:'cloud'}}}};
  const both=planEnterFusion(local,{workerProvider:'local-llama'},()=>true);
  assert.equal(both.write,false); assert.match(both.refusal,/one Fusion role at a time/);
});
test('on llama.cpp (after a recovery) the one local row keeps llama.cpp and still names no engine',()=>{
  const {context:c}=fixture('llama-server');
  assert.deepEqual(Array.from(c.composerLocalEngineRows(),r=>[r.id,r.label,r.active]),[['llama-server','This computer',true]]);
  assert.equal(c.composerFusionEngineRows('worker').filter(r=>r.type==='localEngine').length,1);
  assert.equal(typeof c.composerCoreChoice,'undefined');
});
test('the seat that does not hold the local slot shows it busy under the same neutral name',()=>{
  const {context:c}=fixture();
  const busy=c.composerFusionEngineRows('orchestrator').filter(r=>r.type==='localBusy');
  assert.equal(busy.length,1); assert.equal(busy[0].label,c.composerEngineName());
  assert.equal(busy[0].detail,'Busy as the worker \u00b7 \u21c4 swaps the roles');
});
test('a config with no engine named runs Atomic Chat Core, the default',()=>{
  for (const engine of [null, '', 'something-else']) {
    const {context:c}=fixture(engine);
    assert.equal(c.composerEngineId(),'atomic-core');
    assert.deepEqual(Array.from(c.composerLocalEngineRows(),r=>[r.id,r.active]),[['atomic-core',true]]);
  }
  assert.equal(fixture('llama-server').context.composerEngineId(),'llama-server');
});
