'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { codexDraftStorageKey, registerCodexDraftCommands } = require('../extension/codex/codex_drafts');

function scope(root, saved = new Map()) {
  const commands = new Map();
  const vscode = {
    workspace: { workspaceFolders: root ? [{uri:{toString:()=>root}}] : [] },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return {dispose(){}}; },
      executeCommand(name, ...args) { assert(commands.has(name), name); return commands.get(name)(...args); }
    }
  };
  const context = {globalState:{get:key=>saved.get(key), async update(key,value){
    if(value===undefined) saved.delete(key); else saved.set(key,value);
  }},subscriptions:[]};
  registerCodexDraftCommands(vscode,context);
  return {vscode,context,saved};
}
function providerFor(scoped) {
  const seen = [], forwarded = [];
  const webview = {
    async postMessage(msg) { seen.push(msg); return true; },
  };
  const provider = {
    initializeWebview() {},
    handleMessage(webview,message) { forwarded.push(message); return message; }
  };
  const script = fs.readFileSync(path.join(__dirname,'../assets/codex/drafts-host.js'),'utf8');
  const host = vm.createContext({Promise});
  vm.runInContext(script,host);
  host.scmToolkitProtectCodexDrafts(provider,scoped.vscode);
  provider.initializeWebview(webview);
  return {provider,webview,seen,forwarded};
}
async function run() {
  const shared = new Map();
  const repoA=scope('file:///workspace/a',shared),repoB=scope('file:///workspace/b',shared);
  const noRepo=scope(null,shared);
  assert.notEqual(codexDraftStorageKey(repoA.vscode),codexDraftStorageKey(repoB.vscode));
  assert.equal(codexDraftStorageKey(noRepo.vscode),undefined);
  const a=providerFor(repoA),b=providerFor(repoB);
  const atom='composer-prompt-drafts-v1';
  const updates=(repo, draft)=>repo.provider.handleMessage(repo.webview,{
    type:'persisted-atom-update',key:atom,
    value:{'new-conversation':draft,'local:thread-id':'Thread draft'}
  });
  await updates(a,'Draft for A');
  await updates(b,'Draft for B');
  assert.equal((await repoA.vscode.commands.executeCommand('sweetiebot.codexDraft.read')).draft,'Draft for A');
  assert.equal((await repoB.vscode.commands.executeCommand('sweetiebot.codexDraft.read')).draft,'Draft for B');
  assert(!('new-conversation' in a.forwarded[0].value));
  assert.equal(a.forwarded[0].value['local:thread-id'],'Thread draft');
  const originalState={feature:true,[atom]:{'new-conversation':'Leaked legacy draft','local:thread-id':'Thread draft'}};
  await a.webview.postMessage({type:'persisted-atom-sync',state:originalState});
  await b.webview.postMessage({type:'persisted-atom-sync',state:originalState});
  assert.equal(a.seen[0].state[atom]['new-conversation'],'Draft for A');
  assert.equal(b.seen[0].state[atom]['new-conversation'],'Draft for B');
  assert.equal(originalState[atom]['new-conversation'],'Leaked legacy draft');
  assert.equal(b.seen[0].state[atom]['local:thread-id'],'Thread draft');
  await b.webview.postMessage({type:'persisted-atom-updated',key:atom,value:originalState[atom]});
  assert.equal(b.seen[1].value['new-conversation'],'Draft for B');
  await repoA.vscode.commands.executeCommand('sweetiebot.codexDraft.write',null);
  await a.webview.postMessage({type:'persisted-atom-sync',state:originalState});
  assert(!('new-conversation' in a.seen[1].state[atom]));
  assert.equal(b.seen[0].state.feature,true,'Unrelated atoms intact');
  assert.deepEqual(await noRepo.vscode.commands.executeCommand('sweetiebot.codexDraft.read'),{enabled:false});
  assert.equal(await noRepo.vscode.commands.executeCommand('sweetiebot.codexDraft.write','ignored'),false);

  // A broken or unsupported atom value is forwarded without altering thread state.
  await a.provider.handleMessage(a.webview,{type:'persisted-atom-update',key:atom,value:'broken-json'});
  assert.equal(a.forwarded.at(-1).value,'broken-json');

  let memory = new Map([['codex:persisted-atom:composer-prompt-drafts-v1', JSON.stringify(originalState[atom])],
    ['other', 'keep']]);
  class Storage {
    getItem(k){return memory.get(k)??null;}
    setItem(k,v){memory.set(k,String(v));}
  }
  const store = new Storage();
  const webJs=fs.readFileSync(path.join(__dirname,'../assets/codex/drafts-webview.js'),'utf8');
  vm.runInNewContext(webJs,{Storage,window:{localStorage:store}});
  assert.equal(JSON.parse(store.getItem('codex:persisted-atom:composer-prompt-drafts-v1'))['new-conversation'],undefined);
  assert.equal(JSON.parse(memory.get('codex:persisted-atom:composer-prompt-drafts-v1'))['new-conversation'],'Leaked legacy draft');
  store.setItem('codex:persisted-atom:composer-prompt-drafts-v1',JSON.stringify({'new-conversation':'Draft C','local:thread-id':'Thread C'}));
  assert.equal(JSON.parse(memory.get('codex:persisted-atom:composer-prompt-drafts-v1'))['new-conversation'],undefined);
  assert.equal(JSON.parse(store.getItem('codex:persisted-atom:composer-prompt-drafts-v1'))['local:thread-id'],'Thread C');
  assert.equal(store.getItem('other'),'keep');
  console.log('Codex repository-scoped draft IPC and fallback tests passed.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
