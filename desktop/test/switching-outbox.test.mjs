import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../renderer/renderer.js',import.meta.url),'utf8');
const ast = ts.createSourceFile('renderer.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n=>[n.name.text,n.getText(ast)]));
function fixture() {
  const sent=[], notices=[], kept=new Map(); let id=0;
  const c = vm.createContext({
    S:{draft:'hello',queued:[],busy:false,pending:null,sessionId:'',agentSession:null,log:[],live:{state:'connected'}},
    SWX:{pending:1,want:{model:'new'}}, BSW:{gating:false},VOICE:{state:'idle'},OPENING:null,
    DRAIN_OWED:false,STEER:{ahead:0},MAX_QUEUED:20,QUEUES:kept,PENDING_CHATS:new Map(),RUNNING:new Map(),SESSIONS:[],PENDING_GRACE_MS:5000,
    crypto:{randomUUID:()=>String(++id)},$:()=>null,ctxDraftChanged(){},render(){},
    toast:(...a)=>notices.push(a),localTurnGate:()=>({kind:'run'}),startLiveTurn:t=>{sent.push({text:t,sid:c.S.agentSession});c.S.busy=true;},
    nid:()=>String(++id),esc:s=>s,ic:s=>s,notSent:()=>{throw Error('lost an accepted message');},
    bswSnapshot:async()=>{},console,
  });
  for (const name of ['submit','sendButton','swxWaitsForRoute','openHoldsComposer','noteWaitingChat','drainQueued','drainOwed','queueKey','stashQueue','mergeQueue','restoreQueue','queuesSnapshot','chatQueuedCount','settlePendingChats','queueChatRunning','unqueueMessage','swxMessageOutcome']) vm.runInContext(functions.get(name),c);
  return {c,sent,notices,kept};
}
test('Send accepts during a switch, preserves order, and dispatches only after readiness',()=>{
  const {c,sent,notices}=fixture();
  assert.doesNotMatch(c.sendButton(),/disabled/);
  c.submit(); const sid=c.S.sessionId;
  assert.match(sid,/^waiting-/); assert.equal(c.S.draft,''); assert.equal(c.S.busy,false);
  assert.equal(c.S.queued[0],'hello'); assert.equal(sent.length,0);
  assert.match(notices[0][1],/reply may take longer/);
  c.S.draft='second';c.submit();c.drainQueued();assert.equal(sent.length,0);
  c.SWX.pending=0;c.drainOwed();c.drainOwed();
  assert.deepEqual(sent,[{text:'hello',sid}]);assert.equal(c.S.queued[0],'second');
});
test('a waiting first message survives changing chats and queue persistence',()=>{
  const {c,sent}=fixture();c.submit();const sid=c.S.sessionId;
  assert.equal(c.queuesSnapshot()[sid][0],'hello');
  c.stashQueue();c.S.sessionId='other';c.S.agentSession='other';c.drainOwed();assert.equal(sent.length,0);
  c.restoreQueue(sid);c.S.sessionId=sid;c.S.agentSession=sid;c.SWX.pending=0;c.drainOwed();
  assert.deepEqual(sent,[{text:'hello',sid}]);
});
test('queue full keeps the draft; cancelled messages never dispatch; failed readiness retains accepted text',()=>{
  const {c,sent}=fixture();c.S.queued=Array(20).fill('earlier');c.submit();assert.equal(c.S.draft,'hello');
  c.S.queued=[];c.submit();c.SWX.pending=0;c.localTurnGate=()=>({kind:'block',text:'Model unavailable'});c.drainOwed();
  assert.equal(c.S.queued[0],'hello');assert.equal(sent.length,0);
  c.S.queued.splice(0,1);c.localTurnGate=()=>({kind:'run'});c.drainOwed();assert.equal(sent.length,0);
});
test('selector downloads dismiss the overlay, allow reopening the picker and offer Switch on completion',async()=>{
  let listener;const notices=[];let closed=0,started=0;
  const c=vm.createContext({SEL:{pulling:null,kind:'model',localBusy:false,modelsBusy:false},DL:{},WIZ:{phase:null},
    BR:{modelsPull:async()=>{started++;return {ok:true};},onPull:fn=>{listener=fn;}},
    xpullOwner:()=>c.SEL.pulling,dlChipBusy:()=>false,closeSelector:()=>{closed++;},render(){},bswSnapshot(){},
    toast:(...a)=>notices.push(a),selRows:()=>[],selShell:(title,body)=>title+body,
    document:{querySelector:()=>null},
  });
  for(const name of ['selPull','selectorHTML'])vm.runInContext(functions.get(name),c);
  const a=source.indexOf('if (BR) {\n  // The composer');
  const b=source.indexOf('/* Hooks for',a);
  vm.runInContext(source.slice(a,b),c);
  c.selPull('new-model');await Promise.resolve();
  assert.equal(closed,1);assert.equal(started,1);assert.equal(c.SEL.pulling,'new-model');
  assert.match(c.selectorHTML(),/Nothing to show/);
  c.selPull('another-model');assert.equal(started,1);
  listener({done:true,ok:true});assert.equal(c.SEL.pulling,null);assert.equal(c.DL.ready.id,'new-model');
  assert.equal(closed,1);assert.match(notices.at(-1)[1],/Switch/);
});

test('failed switching retains the accepted message until another route succeeds',()=>{
  const {c,sent}=fixture();c.submit();c.SWX.pending=0;c.SWX.sendError='Switch failed';
  c.drainOwed();assert.equal(sent.length,0);assert.equal(c.S.queued[0],'hello');
  c.SWX.sendError=null;c.drainOwed();assert.equal(sent.length,1);
});
test('a waiting sidebar row survives a long load and disappears when its last message is cancelled',()=>{
  const {c}=fixture();c.submit();const sid=c.S.sessionId;
  c.PENDING_CHATS.get(sid).endedAt=1;c.settlePendingChats();assert.ok(c.PENDING_CHATS.has(sid));
  c.unqueueMessage(0);assert.equal(c.PENDING_CHATS.has(sid),false);assert.equal(c.S.sessionId,'');assert.equal(c.S.agentSession,null);
});

test('a later successful mode does not clear a failed route, and failed mode holds dispatch too',()=>{
  const {c,sent}=fixture();c.submit();c.SWX.pending=0;
  c.swxMessageOutcome('route',false);c.swxMessageOutcome('mode',true);c.drainOwed();assert.equal(sent.length,0);
  c.swxMessageOutcome('mode',false);c.swxMessageOutcome('route',true);c.drainOwed();assert.equal(sent.length,0);
  c.swxMessageOutcome('mode',true);c.drainOwed();assert.equal(sent.length,1);
});
