import http from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root='/Users/aleksejkalina/code/atomicbot/atomic-agent';
const out='/tmp/atomic-e2e-smoke-openai';
process.env.ATOMIC_AGENT_STATE_DIR=out+'/state';
process.env.ATOMIC_AGENT_JUDGE_DISABLED='1';
const {spawnAgentRun}=await import(root+'/eval/harness/spawn-agent.ts');
const {collectTraceMetrics}=await import(root+'/eval/harness/parse-trace-metrics.ts');
const {parseCliOutput}=await import(root+'/eval/harness/parse-cli-output.ts');
const {USER_CONFIG_DEFAULTS}=await import(root+'/dist/config/config-schema.js');
const requests=[];let mainCalls=0;
const json=(res,payload)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));};
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 let body={};try{body=JSON.parse(raw)}catch{}
 requests.push({path:req.url,method:req.method,body});
 if(req.url?.endsWith('/models'))return json(res,{object:'list',data:[{id:'smoke-native',object:'model'}]});
 if(req.url?.endsWith('/embeddings'))return json(res,{object:'list',data:[{index:0,embedding:[1,0,0,0,0,0,0,0]}],usage:{prompt_tokens:1,total_tokens:1}});
 if(req.url?.endsWith('/chat/completions')){
  const hasTools=Array.isArray(body.tools)&&body.tools.length>0;
  if(!hasTools)return json(res,{id:'title',model:'smoke-native',choices:[{index:0,message:{role:'assistant',content:'Smoke'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  mainCalls++;
  const name=mainCalls===1?'os__fs__read':'reply';
  const args=JSON.stringify(mainCalls===1?{path:'marker.txt'}:{text:'SMOKE-OPENAI-NATIVE-8352'});
  assert(body.tools.some(t=>t.function.name===name));
  if(body.stream){
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   const push=delta=>res.write('data: '+JSON.stringify({id:'gen-'+mainCalls,object:'chat.completion.chunk',model:'smoke-native',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
   push({role:'assistant',tool_calls:[{index:0,id:'call-'+mainCalls,type:'function',function:{name,arguments:args.slice(0,Math.floor(args.length/2))}}]});
   await new Promise(r=>setTimeout(r,20));
   push({tool_calls:[{index:0,function:{arguments:args.slice(Math.floor(args.length/2))}}]});
   res.write('data: '+JSON.stringify({id:'gen-'+mainCalls,object:'chat.completion.chunk',model:'smoke-native',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:12,total_tokens:112}})+'\n\n');
   res.end('data: [DONE]\n\n');return;
  }
  return json(res,{id:'gen-'+mainCalls,model:'smoke-native',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call-'+mainCalls,type:'function',function:{name,arguments:args}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:12,total_tokens:112}});
 }
 res.writeHead(404);res.end('not found');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;const url='http://127.0.0.1:'+port;
let result;
try{
 mkdirSync(out+'/state',{recursive:true});mkdirSync(out+'/work',{recursive:true});
 writeFileSync(out+'/work/marker.txt','SMOKE-OPENAI-NATIVE-8352\n');
 const config=structuredClone(USER_CONFIG_DEFAULTS);
 config.analytics={enabled:false};
 for(const value of Object.values(config.memory)){if(value&&typeof value==='object'&&'enabled' in value)value.enabled=false;}
 config.agent.maxSteps=8;config.agent.approvalRequired=false;config.tracing.trace.enabled=true;
 config.localModels.url=url;
 config.llm={activeTextProvider:'smoke-openai',activeEmbeddingProvider:'smoke-openai',toolTransport:'native_tools',providers:[{id:'smoke-openai',kind:'openai-compatible',baseUrl:url+'/v1',defaultChatModel:'smoke-native',defaultEmbeddingModel:'smoke-embed',supportsTools:true,apiKey:'local-dummy',requestTimeoutMs:5000}]};
 writeFileSync(out+'/state/config.json',JSON.stringify(config,null,2));
 result=await spawnAgentRun({workingDir:out+'/work',stateDir:out+'/state',prompt:'Read marker.txt with os.fs.read and reply with its exact marker.',maxSteps:8,timeoutMs:45000,requireDist:true});
 writeFileSync(out+'/cli-result.json',JSON.stringify(result,null,2));
 assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);
 const cli=parseCliOutput(result.stdout,result.stderr);
 assert.equal(cli.reply,'SMOKE-OPENAI-NATIVE-8352');assert.equal(cli.lastError,null);
 const metrics=await collectTraceMetrics(join(out,'state','traces',cli.sessionId+'.ndjson'));
 assert(metrics.toolInvocations.some(i=>i.tool==='os.fs.read'&&i.status==='ok'));
 assert(metrics.toolInvocations.some(i=>i.tool==='reply'&&i.status==='ok'));
 assert.equal(metrics.parseRetries,0);assert.equal(metrics.toolErrorCount,0);assert.equal(mainCalls,2);
 const mains=requests.filter(r=>Array.isArray(r.body.tools)&&r.body.tools.length>0);
 assert(mains.every(r=>r.body.stream===true));
 assert(mains[1].body.messages.some(m=>m.role==='tool'&&JSON.stringify(m).includes('SMOKE-OPENAI-NATIVE-8352')));
 assert(mains[1].body.messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.function.name==='os__fs__read')));
 const summary={passed:true,node:process.version,provider:'openai-compatible local mock',transport:'native_tools',actualDist:true,mainCompletions:mainCalls,splitSseArguments:true,nativeAssistantToolHistory:true,nativeToolResultHistory:true,cliFinalReply:cli.reply,metrics,requests:requests.map(r=>({path:r.path,stream:r.body.stream,model:r.body.model,tools:r.body.tools?.length}))};
 writeFileSync(out+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
}finally{writeFileSync(out+'/requests.json',JSON.stringify(requests,null,2));server.closeAllConnections();await new Promise(r=>server.close(r));}
