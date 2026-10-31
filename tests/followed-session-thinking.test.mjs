import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import { resolveMessageResponseStyle, responsePresentationFromSettings } from '../extension/lib/response-presentation.mjs';
const source=await readFile(new URL('../extension/sidepanel.js',import.meta.url),'utf8');
const body=source.match(/function renderCompletionPendingRow\(\) \{[\s\S]*?\n\}/)[0];
test('a subagent completion wait never adds a second thinking card beside an active live card',()=>{
 const {document}=parseHTML('<html><body><div id=messages><div class=message-row><article class="message assistant"><span class=thinking-indicator>thinking</span></article></div></div><template id=template><article class=message><div class=message-role></div><div class=message-content></div></article></template></body></html>');
 const ctx=vm.createContext({resolveMessageResponseStyle,responsePresentationFromSettings,settings:{},els:{messages:document.getElementById('messages'),template:document.getElementById('template')},completionSettlePending:true,assistantMessageRoleLabel:()=> 'Hermes',THINKING_PLACEHOLDER:'Thinking',renderMessageContentElement:(node)=>{node.innerHTML='<span class=thinking-indicator>thinking</span>';},scrollMessageStreamToBottom:()=>{}});
 vm.runInContext(`${body};renderCompletionPendingRow()`,ctx);
 assert.equal(document.querySelectorAll('.thinking-indicator').length,1);
 assert.equal(document.querySelector('.completion-pending-row'),null);
});
test('a wait-only thinking card uses the normal styled message renderer',()=>{
 const {document}=parseHTML('<html><body><div id=messages></div><template id=template><article class=message><div class=message-role></div><div class=message-content></div></article></template></body></html>');
 const messages=document.getElementById('messages');const calls=[];
 const ctx=vm.createContext({resolveMessageResponseStyle,responsePresentationFromSettings,settings:{},els:{messages,template:document.getElementById('template')},completionSettlePending:true,assistantMessageRoleLabel:()=> 'Hermes',THINKING_PLACEHOLDER:'Thinking',renderMessageContentElement:(node)=>{node.innerHTML='<span class=thinking-indicator>thinking</span>';},scrollMessageStreamToBottom:()=>{},addMessage:(role,content,options)=>{calls.push({role,content,options});const row=document.createElement('div');row.className='message-row';row.innerHTML='<article class="message assistant"><span class=thinking-indicator>thinking</span></article>';messages.append(row);return {row,node:row.querySelector('.message')};}});
 vm.runInContext(`${body};renderCompletionPendingRow()`,ctx);
 assert.equal(calls.length,1);
 assert.equal(calls[0].options.persist,false);
 assert.equal(calls[0].options.streaming,true);
 assert.equal(calls[0].options.entering,false);
 assert.ok(document.querySelector('.message-row.completion-pending-row .message.assistant'));
 vm.runInContext('renderCompletionPendingRow()',ctx);
 assert.equal(calls.length,1);
 assert.equal(document.querySelectorAll('.thinking-indicator').length,1);
});
test('the actual message renderer honors entry suppression without changing normal streamed entry',()=>{
 const add=source.match(/function addMessage\([\s\S]*?\} = \{\}\) \{[\s\S]*?\n\}/)[0];
 for(const entering of [undefined,false]){
  const {document}=parseHTML('<html><body><div id=messages></div><template id=template><article class=message><div class=message-role></div><div class=message-content></div></article></template></body></html>');
  const bindings=[];
  const ctx=vm.createContext({resolveMessageResponseStyle,responsePresentationFromSettings,settings:{},document,messages:[{role:'user',content:'Existing prompt'}],els:{messages:document.getElementById('messages'),template:document.getElementById('template')},options:{persist:false,streaming:true,scroll:false,entering},isSteerMessage:()=>false,assistantMessageRoleLabel:()=> 'Hermes',messageDisplayText:(_role,content)=>content,renderMessageContentElement:(node,content)=>{node.textContent=content;},normalizeMessageTimestamp:()=>null,applyRoomMessageIdentity:()=>{},applySoloBotIdentity:()=>{},messageThreadUi:()=>({attach:(binding)=>bindings.push(binding)}),activeGroupProjection:null,setRailCopyEnabled:()=>{}});
  vm.runInContext(`${add};addMessage('assistant','Thinking',options)`,ctx);
  assert.equal(bindings[0].entering,entering===undefined);
  assert.ok(document.querySelector('.message-row .message.assistant'));
 }
});
