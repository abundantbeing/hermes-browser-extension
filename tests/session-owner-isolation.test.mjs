import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {rosterStopTarget} from '../extension/lib/live-session-attach.mjs';
import {liveIdForRunSettle} from '../extension/lib/run-control-lifecycle.mjs';
const panel=await readFile(new URL('../extension/sidepanel.js',import.meta.url),'utf8');
const fn=(source,name)=>source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

test('a local writer in A does not make the viewed session B running',()=>{
 const ctx=vm.createContext({sending:true,settings:{sessionId:'B'},activeRunControl:{sessionId:'A',scopeRevisionId:1},localSessionStream:{sessionId:'A'},liveAttach:null,liveSessionRows:new Map(),scopeRevision:{isCurrent:()=>true},localRunIsViewed:()=>false});
 assert.equal(vm.runInContext(`${fn(panel,'viewedSessionIsRunning')};viewedSessionIsRunning()`,ctx),false);
});
test('Stop from B refuses before touching the local writer in A',async()=>{
 const ctx=vm.createContext({sending:true,settings:{sessionId:'B'},liveAttach:null,liveSessionRows:new Map(),liveSessionRosterScope:'',liveSessionScopeKey:()=>'',activeDashboardWsConnection:null,rosterStopTarget,localRunIsViewed:()=>false,usesDashboardWsChatTransport:()=>false,activeRunControl:{phase:'running'},requestRunStop:()=>{throw new Error('Wrong-session Stop reached the writer');}});
 assert.equal(await vm.runInContext(`${fn(panel,'stopCurrentTurn')};stopCurrentTurn()`,ctx),false);
});
test('settling A cannot flush its queued message into B',async()=>{
 const writes=[]; const queued={sessionId:'A',scopeRevisionId:1,text:'A follow-up',autoSend:true};
 const ctx=vm.createContext({liveIdForRunSettle,activeDashboardWsConnection:null,promptController:{settleScope:()=>{}},activeRunControl:{phase:'terminal',writerLease:'released',sessionId:'A',scopeRevisionId:1},RUN_CONTROL_PHASES:{TERMINAL:'terminal'},activeAbortController:null,activeRunId:'rA',pendingSteerText:'',sending:true,settings:{sessionId:'B'},queuedTurn:queued,updateComposerBusyState:()=>{},renderContextWindow:()=>{},recheckBuildIdentityAfterUpdateTurn:()=>{},shouldAutoFlushQueuedTurn:()=>true,renderQueueNotice:()=>{},scopeRevision:{isCurrent:()=>true},pendingForeignTurn:null,setStatus:()=>{},askHermes:async text=>{writes.push(text);return false;}});
 const helper=panel.match(/async function flushQueuedTurnForSession\([^\n]*\) \{[\s\S]*?\n\}/)?.[0]||'';
 await vm.runInContext(`${helper}\n${fn(panel,'settleActiveRunTerminal')};settleActiveRunTerminal()`,ctx);
 assert.equal(writes.length,0); assert.equal(ctx.queuedTurn,queued);
});
test('a refused queue submission preserves its text',async()=>{
 const queued={sessionId:'A',scopeRevisionId:1,text:'Keep this draft',autoSend:true};
 const helper=panel.match(/async function flushQueuedTurnForSession\([^\n]*\) \{[\s\S]*?\n\}/)?.[0];
 assert.ok(helper,'one session-bound queue drain owns rejected submissions');
 const ctx=vm.createContext({queuedTurn:queued,settings:{sessionId:'A'},sending:false,scopeRevision:{isCurrent:()=>true},pendingForeignTurn:null,renderQueueNotice:()=>{},setStatus:()=>{},askHermes:async()=>false});
 await vm.runInContext(`${helper};flushQueuedTurnForSession('A',1)`,ctx);
 assert.equal(ctx.queuedTurn.text,'Keep this draft');
});
test('dashboard steering cancels before an RPC if navigation changes the target during connection setup',async()=>{
 let release;const requests=[];const settings={sessionId:'A'};
 const ctx=vm.createContext({settings,sessionLoadRequestId:1,scopeRevision:{current:()=>1,isCurrent:()=>true},pendingSteerText:'',liveAttach:null,viewedSessionIsRunning:()=>true,localRunIsViewed:()=>settings.sessionId==='A',usesDashboardWsChatTransport:()=>true,canSteerActiveRun:()=>true,setStatus:()=>{},ensureActiveDashboardWsConnection:()=>new Promise(resolve=>{release=resolve;}),ensureRemoteWsSession:async()=> 'live-B',WS_METHODS:{sessionSteer:'session.steer'}});
 const pending=vm.runInContext(`${fn(panel,'sendSteerText')};sendSteerText('A correction')`,ctx);
 settings.sessionId='B';ctx.sessionLoadRequestId=2;
 release({client:{request:async(method,params)=>{requests.push({method,params});return {status:'queued'};}}});
 await pending;
 assert.equal(requests.length,0);
});

test('a run in session A never locks a new session B: releaseBackgroundLocalRun frees the composer',()=>{
 const ctx=vm.createContext({sending:true,settings:{sessionId:'B'},activeGroupProjection:null,activeAbortController:{},activeRunId:'rA',
  activeRunControl:{phase:'running',sessionId:'A',scopeRevisionId:1},RUN_CONTROL_PHASES:{TERMINAL:'terminal'},
  markRunTerminal:(state,status)=>({...state,phase:'terminal',writerLease:'released',terminalStatus:status}),
  localRunIsViewed:()=>false,updateComposerBusyState:()=>{}});
 const src=`${fn(panel,'localTurnBlocksNavigation')};${fn(panel,'releaseBackgroundLocalRun')};`;
 assert.equal(vm.runInContext(`${src}localTurnBlocksNavigation()`,ctx),false);
 assert.equal(vm.runInContext(`${src}releaseBackgroundLocalRun()`,ctx),true);
 assert.equal(ctx.sending,false); assert.equal(ctx.activeRunControl.phase,'terminal'); assert.equal(ctx.activeRunControl.writerLease,'released');
});
test('a run in the session you are viewing still holds the composer',()=>{
 const ctx=vm.createContext({sending:true,settings:{sessionId:'A'},activeGroupProjection:null,activeRunControl:{phase:'running'},RUN_CONTROL_PHASES:{TERMINAL:'terminal'},localRunIsViewed:()=>true,updateComposerBusyState:()=>{}});
 const src=`${fn(panel,'localTurnBlocksNavigation')};${fn(panel,'releaseBackgroundLocalRun')};`;
 assert.equal(vm.runInContext(`${src}localTurnBlocksNavigation()`,ctx),true);
 assert.equal(vm.runInContext(`${src}releaseBackgroundLocalRun()`,ctx),false);
 assert.equal(ctx.sending,true);
});
