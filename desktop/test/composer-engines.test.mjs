import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planEnterFusion } = require('../out/main/run-mode.js');
const source = readFileSync(new URL('../renderer/composer-engines.js', import.meta.url), 'utf8');
function fixture() {
  const rm = {orchestratorProviderId:'cloud', workerProviderId:'local-llama'};
  const context = {llmManaged:()=>({engine:'atomic-core'}), rmNow:()=>rm,
    selProviders:()=>[{id:'cloud'},{id:'second'}], BSW:{readyIds:['cloud','second']},
    selBackend:()=> 'fusion', SEL:{kind:'workers',models:[{id:'remote-model'}],filter:''},
    fzSeats:()=>({plans:{provider:rm.orchestratorProviderId,label:'remote-model'},works:{provider:rm.workerProviderId,label:'local-model'}}),
    selLocalMatches:()=>[{id:'local-model',downloaded:true},{id:'missing',downloaded:false}], llmModelName:m=>m.id,
    modelMatches:()=>true};
  runInNewContext(source,context);
  return {context,rm};
}
test('Local engine picker has both engines with one accurate selected mark',()=>{
  const {context:c}=fixture(); const rows=c.composerLocalEngineRows();
  assert.equal(rows.length,2); assert.equal(rows[0].label,'Local llama');
  assert.equal(rows[1].label,'Atomic Chat'); assert.equal(rows[1].active,true); assert.equal(rows[0].active,false);
});
test('Fusion engine and model menus are separate, with catalogs scoped to each role',()=>{
  const {context:c,rm}=fixture();
  assert.equal(c.composerFusionEngineRows('worker').filter(r=>r.type==='localEngine').length,2);
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
