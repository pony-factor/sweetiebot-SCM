"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const load = (name, context) => vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/codex',name),'utf8'),context);
(async () => {
  let receive, hidden, clicked=0;
  const posted=[];
  const button={getClientRects:()=>[1],getAttribute:()=>null,click(){clicked++;},dispatchEvent(){throw Error('The already-open menu must not be toggled again');}};
  const context=vm.createContext({window:{addEventListener(_type,fn){receive=fn;}},requestAnimationFrame:fn=>fn(),document:{
    head:{append(){}},createElement:()=>({}),documentElement:{toggleAttribute(_key,value){hidden=value;}},
    querySelectorAll:()=>[button],querySelector:selector=>selector.startsWith('button')?button:{}
  }});
  load('permissions-webview.js',context);
  context.scmToolkitRegisterCodexPermissionsMenu({postMessage:message=>posted.push(message)});
  assert.equal(posted[0].type,'sweetiebot-permissions-ready');
  receive({data:{type:'sweetiebot-permissions-visibility',hidden:true}}); assert.equal(hidden,true);
  receive({data:{type:'sweetiebot-permissions-visibility',hidden:false}}); assert.equal(hidden,false);
  receive({data:{type:'sweetiebot-open-permissions'}}); assert.equal(clicked,1);
  assert.equal(posted.at(-1).type,'sweetiebot-permissions-opened');
  assert.equal(posted.at(-1).opened,true);
  assert.equal(posted.length,2,'Opening the native chooser only acknowledges UI; it never writes an access policy');
  const commands=new Map(),messages=[];
  let configChanged,show=false;
  const view={postMessage:async message=>{messages.push(message);if(message.type==='sweetiebot-open-permissions') provider.handleMessage(view,{type:'sweetiebot-permissions-opened',id:message.id,opened:true});return true;}};
  const provider={initializeWebview(){},handleMessage(){},sidebarView:{webview:view}};
  const editor={workspace:{getConfiguration:()=>({get:()=>show}),onDidChangeConfiguration:fn=>{configChanged=fn;return {dispose(){}};}},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return {dispose(){}};},executeCommand:async id=>assert.equal(id,'chatgpt.openSidebar')}};
  const host=vm.createContext({require,setTimeout,clearTimeout});load('permissions-host.js',host);
  const registration=host.scmToolkitRegisterCodexPermissions(provider,editor);
  provider.initializeWebview(view,'sidebar',()=>{});
  provider.handleMessage(view,{type:'sweetiebot-permissions-ready'});
  assert.equal(messages.at(-1).hidden,false);
  show=true;configChanged({affectsConfiguration:()=>true});assert.equal(messages.at(-1).hidden,true);
  await commands.get('sweetiebot.codex.openPermissions')();assert.equal(messages.at(-1).type,'sweetiebot-open-permissions');
  registration.dispose();
  console.log('Magic permissions chooser, live icon visibility, and unchanged access policies passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
