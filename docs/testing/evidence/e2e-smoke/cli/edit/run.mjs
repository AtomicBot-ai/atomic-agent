import {spawn} from 'node:child_process';
import {writeFileSync, readFileSync, existsSync} from 'node:fs';
import {once} from 'node:events';
const root='/Users/aleksejkalina/code/atomicbot/atomic-agent';
const out='/tmp/atomic-e2e-smoke-cli/edit';
const {runCase}=await import(root+'/eval/harness/run-case.ts');
const {EVAL_CASES}=await import(root+'/eval/cases/index.ts');
const {startMockHttp}=await import(root+'/eval/harness/start-mock-http.ts');
const port=19084;
process.env.ATOMIC_AGENT_EVAL_LLAMA_URL=`http://127.0.0.1:${port}`;
process.env.ATOMIC_AGENT_JUDGE_DISABLED='1';
process.env.ATOMIC_AGENT_STATE_DIR=out+'/runner-state';
if (!existsSync(root+'/dist/cli/index.js')) throw Error('dist required');
const stub=spawn(process.execPath,['/tmp/atomic-e2e-smoke-cli/stub-with-edit.mjs','--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
let stubOutput=''; stub.stdout.on('data',c=>stubOutput+=c);stub.stderr.on('data',c=>stubOutput+=c);
let mock;const results=[];
try {
 for(let i=0;i<50;i++){try{if((await fetch(process.env.ATOMIC_AGENT_EVAL_LLAMA_URL+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 mock=await startMockHttp();
 const specs=EVAL_CASES.slice(0,15).filter(s=>!s.expectations.some(e=>e.kind==='judge') && ['coding-fix-cart-total','debug-fix-slugify','coding-wire-shared-tax-rate'].includes(s.id));
 for(const original of specs){
  const spec=original.id==='debug-fix-slugify'||original.id==='coding-wire-shared-tax-rate'?{...original,expectations:[...original.expectations,{kind:'batch_size_min',min:2}]}:original;
  const result=await runCase(spec,{mockHttpUrl:mock.url,judge:null,timeoutMs:45000});
  results.push(result);
  writeFileSync(out+'/'+spec.id+'.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({case:spec.id,passed:result.passed,exit:result.spawn.exitCode,timedOut:result.spawn.timedOut,steps:result.metrics.stepCount,maxBatch:result.metrics.maxBatchSize,tools:result.metrics.toolInvocations,failures:result.failures}));
 }
}finally{
 if(mock)await mock.close();
 stub.kill('SIGTERM'); await Promise.race([once(stub,'close'),new Promise(r=>setTimeout(()=>{stub.kill('SIGKILL');r();},2000))]);
 writeFileSync(out+'/stub.log',stubOutput);
 writeFileSync(out+'/results.json',JSON.stringify({node:process.version,cli:root+'/dist/cli/index.js',judge:'not loaded; no judge cases',passed:results.filter(r=>r.passed).length,total:results.length,results},null,2));
}
if(results.some(r=>!r.passed))process.exitCode=1;
