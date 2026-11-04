'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { codexDraftStorageKey, registerCodexDraftCommands } = require('../extension/codex/drafts');

function scope(root, saved = new Map()) {
  const commands = new Map();
  const vscode = {
    workspace: { workspaceFolders: root ? [{uri:{toString:()=>root,fsPath:root.replace('file://','')}}] : [] },
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

  const attachmentAtom = 'sweetiebot-composer-attachments-v1';
  const attachmentDrafts = { 'new-conversation': {
    imageAttachments: [{ id:'image-1', src:'data:image/png;base64,aGVsbG8=', localPath:'/tmp/pasted-image.png', filename:'pasted.png' }],
    fileAttachments: ['/workspace/a/report.pdf'],
    uploadedFileAttachments: [{ id:'upload-1', name:'notes.txt', status:'uploaded' }],
    attachmentOrder: ['["image","image-1"]','["file","/workspace/a/report.pdf"]']
  }};
  await a.provider.handleMessage(a.webview,{type:'persisted-atom-update',key:attachmentAtom,value:attachmentDrafts});
  assert(!a.forwarded.some(message=>message.key===attachmentAtom),'Never write attachments to the native account-wide store');
  await a.webview.postMessage({type:'persisted-atom-sync',state:{[attachmentAtom]:{leaked:'Other workspace'}}});
  await b.webview.postMessage({type:'persisted-atom-sync',state:{[attachmentAtom]:attachmentDrafts}});
  assert.deepEqual(a.seen.at(-1).state[attachmentAtom],attachmentDrafts);
  assert.deepEqual(b.seen.at(-1).state[attachmentAtom],{},'Attachments cannot leak between worktrees');
  const reopened=providerFor(scope('file:///workspace/a',shared));
  await reopened.webview.postMessage({type:'persisted-atom-sync',state:{}});
  assert.deepEqual(reopened.seen.at(-1).state[attachmentAtom],attachmentDrafts,'Image payloads and file order survive reopening');
  const destination=scope('file:///workspace/c',shared);
  const workspace='/workspace/c/draft.code-workspace';
  destination.vscode.workspace.workspaceFile={fsPath:workspace};
  shared.set(require('../extension/codex/workspace-handoff').keyFor(workspace),{
    source:'/workspace/a',destination:'/workspace/c',attachmentDrafts
  });
  const destinationProvider=providerFor(destination);
  await destinationProvider.webview.postMessage({type:'persisted-atom-sync',state:{}});
  assert.equal(destinationProvider.seen.at(-1).state[attachmentAtom]['new-conversation'].fileAttachments[0],'/workspace/c/report.pdf',
    'Initial composer hydration sees the pending handoff before extension activation finishes');
  const failing=scope('file:///workspace/failing');
  failing.context.globalState.update=async()=>{throw new Error('Storage unavailable');};
  const failingProvider=providerFor(failing);
  await assert.rejects(failingProvider.provider.handleMessage(failingProvider.webview,
    {type:'persisted-atom-update',key:attachmentAtom,value:attachmentDrafts}),/Storage unavailable/);
  assert.throws(()=>failing.vscode.commands.executeCommand('sweetiebot.codexDraft.readAttachments'),/Storage unavailable/);
  store.setItem('codex:persisted-atom:'+attachmentAtom,JSON.stringify(attachmentDrafts));
  assert.equal(store.getItem('codex:persisted-atom:'+attachmentAtom),'{}','Global browser fallback cannot leak attachments');
  const attachmentHost=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/codex/composer-attachments.js'),'utf8'),attachmentHost);
  let records={}; const signal={};
  const composer={value:{id:'new-conversation'},get:()=>records,set:(_,value)=>{records=value;}};
  attachmentHost.scmToolkitSaveComposerAttachments(composer,attachmentDrafts['new-conversation'],signal,value=>value.id);
  const restored=attachmentHost.scmToolkitRestoreComposerAttachments(composer,signal,value=>value.id);
  assert.equal(JSON.stringify(restored.imageAttachments),JSON.stringify(attachmentDrafts['new-conversation'].imageAttachments));
  assert.equal(JSON.stringify(restored.attachmentOrder),JSON.stringify(attachmentDrafts['new-conversation'].attachmentOrder));
  attachmentHost.scmToolkitSaveComposerAttachments(composer,{imageAttachments:[],fileAttachments:[],attachmentOrder:[]},signal,value=>value.id);
  assert.equal(Object.keys(records).length,0,'Sending/removing attachments must not resurrect a stale draft');
  console.log('Codex repository-scoped draft IPC and fallback tests passed.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
