'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { codexDraftStorageKey, registerCodexDraftCommands, branchScopes } = require('../../extension/codex/drafts');

function scope(root, saved = new Map(), configuration = {}) {
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
  if (configuration.workspace) vscode.workspace.workspaceFile={fsPath:configuration.workspace,toString:()=>configuration.workspace};
  registerCodexDraftCommands(vscode,context, configuration.branch ? {
    resolveBranches:async()=>[[root,configuration.branch]]
  } : {});
  return {vscode,context,saved};
}
function providerFor(scoped) {
  const seen = [], forwarded = [];
  const webview = {
    async postMessage(msg) { seen.push(msg); return true; },
  };
  const provider = {
    initializeWebview() {},
    sendPersistedAtomState(webview) { return webview.postMessage({type:'persisted-atom-sync',state:{'composer-prompt-drafts-v2':{}}}); },
    handleMessage(webview,message) { forwarded.push(message); return message; }
  };
  const script = fs.readFileSync(path.join(__dirname,'../../assets/codex/drafts-host.js'),'utf8');
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

  // Current Codex persists rich draft objects and sends incremental record updates.
  const atomV2='composer-prompt-drafts-v2';
  const rich={prompt:{document:{type:'doc',content:[{type:'text',text:'Unsent rich prompt'}]},plainTextMode:false},
    pullRequestChecks:[],usedDictation:true};
  const record=(entries,value={})=>a.provider.handleMessage(a.webview,{
    type:'persisted-atom-update',key:atomV2,value,recordUpdate:{entries,legacyStorageKey:atom}
  });
  await record({'new-conversation':{value:rich}},{'new-conversation':rich});
  assert.deepEqual((await repoA.vscode.commands.executeCommand('sweetiebot.codexDraft.read')).draft,rich);
  assert(!('new-conversation' in a.forwarded.at(-1).value));
  assert.equal(a.forwarded.at(-1).recordUpdate.entries['new-conversation'].delete,true);
  await record({'local:thread-id':{value:{prompt:'Thread follow-up',pullRequestChecks:[]}}});
  assert.deepEqual((await repoA.vscode.commands.executeCommand('sweetiebot.codexDraft.read')).draft,rich,
    'A thread-only record update must not clear an unsent new-chat draft');
  const reopenedRich=providerFor(scope('file:///workspace/a',shared));
  await reopenedRich.webview.postMessage({type:'persisted-atom-sync',state:{[atomV2]:{'new-conversation':'Global stale text'}}});
  assert.deepEqual(reopenedRich.seen.at(-1).state[atomV2]['new-conversation'],rich);
  await b.webview.postMessage({type:'persisted-atom-sync',state:{[atomV2]:{'new-conversation':rich}}});
  assert.equal(b.seen.at(-1).state[atomV2]['new-conversation'],'Draft for B');
  await record({'new-conversation':{delete:true,expectedValue:rich}});
  const afterSend=providerFor(scope('file:///workspace/a',shared));
  await afterSend.webview.postMessage({type:'persisted-atom-sync',state:{[atomV2]:{'new-conversation':rich}}});
  assert(!('new-conversation' in afterSend.seen.at(-1).state[atomV2]),
    'Sending clears the scoped cache before a new workspace hydrates');
  await record({'new-conversation':{value:rich}});
  const newer={prompt:'New unsent draft',pullRequestChecks:[]};
  await record({'new-conversation':{value:newer}});
  await record({'new-conversation':{delete:true,expectedValue:rich}});
  assert.deepEqual((await repoA.vscode.commands.executeCommand('sweetiebot.codexDraft.read')).draft,newer,
    'A late send/delete cannot erase a newer draft');
  await record({'new-conversation':{delete:true,expectedValue:{pullRequestChecks:[],prompt:newer.prompt}}});
  await afterSend.webview.postMessage({type:'persisted-atom-updated',key:atomV2,value:{'new-conversation':rich}});
  assert(!('new-conversation' in afterSend.seen.at(-1).value),'A global broadcast cannot resurrect sent text');

  let memory = new Map([['codex:persisted-atom:composer-prompt-drafts-v1', JSON.stringify(originalState[atom])],
    ['other', 'keep']]);
  class Storage {
    getItem(k){return memory.get(k)??null;}
    setItem(k,v){memory.set(k,String(v));}
  }
  const store = new Storage();
  const webJs=fs.readFileSync(path.join(__dirname,'../../assets/codex/drafts-webview.js'),'utf8');
  vm.runInNewContext(webJs,{Storage,window:{localStorage:store}});
  assert.equal(JSON.parse(store.getItem('codex:persisted-atom:composer-prompt-drafts-v1'))['new-conversation'],undefined);
  assert.equal(JSON.parse(memory.get('codex:persisted-atom:composer-prompt-drafts-v1'))['new-conversation'],'Leaked legacy draft');
  store.setItem('codex:persisted-atom:composer-prompt-drafts-v1',JSON.stringify({'new-conversation':'Draft C','local:thread-id':'Thread C'}));
  assert.equal(JSON.parse(memory.get('codex:persisted-atom:composer-prompt-drafts-v1'))['new-conversation'],undefined);
  assert.equal(JSON.parse(store.getItem('codex:persisted-atom:composer-prompt-drafts-v1'))['local:thread-id'],'Thread C');
  memory.set('codex:persisted-atom:'+atomV2,JSON.stringify({'new-conversation':rich,'local:thread-id':newer}));
  assert(!('new-conversation' in JSON.parse(store.getItem('codex:persisted-atom:'+atomV2))));
  store.setItem('codex:persisted-atom:'+atomV2,JSON.stringify({'new-conversation':rich,'local:thread-id':newer}));
  assert(!('new-conversation' in JSON.parse(memory.get('codex:persisted-atom:'+atomV2))));
  assert.deepEqual(JSON.parse(store.getItem('codex:persisted-atom:'+atomV2))['local:thread-id'],newer);
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
  shared.set(require('../../extension/codex/workspace-handoff').keyFor(workspace),{
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
  await assert.rejects(failing.vscode.commands.executeCommand('sweetiebot.codexDraft.readAttachments'),/Storage unavailable/);
  store.setItem('codex:persisted-atom:'+attachmentAtom,JSON.stringify(attachmentDrafts));
  assert.equal(store.getItem('codex:persisted-atom:'+attachmentAtom),'{}','Global browser fallback cannot leak attachments');
  const attachmentHost=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../assets/codex/composer-attachments.js'),'utf8'),attachmentHost);
  let records={}; const signal={};
  const composer={value:{id:'new-conversation'},get:()=>records,set:(_,value)=>{records=value;}};
  attachmentHost.scmToolkitSaveComposerAttachments(composer,attachmentDrafts['new-conversation'],signal,value=>value.id);
  const restored=attachmentHost.scmToolkitRestoreComposerAttachments(composer,signal,value=>value.id);
  assert.equal(JSON.stringify(restored.imageAttachments),JSON.stringify(attachmentDrafts['new-conversation'].imageAttachments));
  assert.equal(JSON.stringify(restored.attachmentOrder),JSON.stringify(attachmentDrafts['new-conversation'].attachmentOrder));
  attachmentHost.scmToolkitSaveComposerAttachments(composer,{imageAttachments:[],fileAttachments:[],attachmentOrder:[]},signal,value=>value.id);
  assert.equal(Object.keys(records).length,0,'Sending/removing attachments must not resurrect a stale draft');
  const configA={workspace:'/windows/a.code-workspace',branch:'main'};
  const configB={workspace:'/windows/b.code-workspace',branch:'main'};
  const windowA=scope('file:///shared/main',shared,configA);
  const windowB=scope('file:///shared/main',shared,configB);
  const command=(window,name,...args)=>window.vscode.commands.executeCommand('sweetiebot.codexDraft.'+name,...args);
  await command(windowA,'write','Window A main draft');
  await command(windowA,'writeAttachments',attachmentDrafts);
  const scopeMain=(await command(windowA,'read')).scope;
  const liveA=providerFor(windowA);
  await liveA.provider.sendPersistedAtomState(liveA.webview);
  assert.equal(liveA.seen.at(-1).scmToolkitDraftScope,scopeMain);
  assert.equal((await command(windowB,'read')).draft,null,'A second window on the same checkout starts empty');
  assert.deepEqual((await command(windowB,'readAttachments')).drafts,{});
  await command(windowB,'write','Window B main draft');
  const reloadedA=scope('file:///shared/main',shared,configA);
  assert.equal((await command(reloadedA,'read')).draft,'Window A main draft','Reload retains window identity');
  configA.branch='topic';
  await command(windowA,'refresh');
  assert.notEqual(liveA.seen.at(-1).scmToolkitDraftScope,scopeMain);
  assert(!('new-conversation' in liveA.seen.at(-1).state[atomV2]),'A branch refresh replaces the visible old-branch draft');
  await liveA.provider.handleMessage(liveA.webview,{type:'persisted-atom-update',key:atomV2,
    scmToolkitDraftScope:scopeMain,recordUpdate:{entries:{'new-conversation':{value:'Late old text'}}},value:{}});
  assert.equal((await command(windowA,'read')).draft,null,'Changing branch selects an independent slot');
  assert.deepEqual((await command(windowA,'readAttachments')).drafts,{});
  assert.equal(await command(windowA,'write','Late main text',{scope:scopeMain}),false);
  assert.equal(await command(windowA,'writeAttachments',attachmentDrafts,{scope:scopeMain}),false);
  assert.equal((await command(windowA,'read')).draft,null,'Delayed old-branch IPC cannot seed the new branch');
  await command(windowA,'write','Topic draft');
  configA.branch='main';
  assert.equal((await command(windowA,'read')).draft,'Window A main draft');
  assert.deepEqual((await command(windowA,'readAttachments')).drafts,attachmentDrafts);
  assert.equal((await command(windowB,'read')).draft,'Window B main draft');

  const transfer={draftScope:scopeMain,draftTransferId:require('node:crypto').randomUUID(),
    source:'/workspace/a',destination:'/shared/destination',draft:'Window A main draft',attachmentDrafts};
  const configC={workspace:'/windows/c.code-workspace',branch:'topic'};
  const windowC=scope('file:///shared/destination',shared,configC);
  // Hydration can happen before the handoff-resume command starts.
  const transferKey=require('../../extension/codex/workspace-handoff').keyFor(configC.workspace);
  shared.set(transferKey,transfer);
  assert.equal((await command(windowC,'read')).draft,transfer.draft);
  assert.equal((await command(windowA,'read')).draft,null,'A successful transfer retires the source copy');
  assert.equal(await command(windowA,'write',transfer.draft,{scope:scopeMain,generation:0}),false,
    'A late IPC write from the old composer cannot recreate the retired source');
  assert.equal(await command(windowA,'writeAttachments',attachmentDrafts,{scope:scopeMain,generation:0}),false);
  assert.deepEqual((await command(windowA,'readAttachments')).drafts,{});
  assert.deepEqual((await command(windowC,'readAttachments')).drafts,
    require('../../extension/codex/workspace-handoff').handoffAttachments(transfer));
  await command(windowC,'write',null);
  await command(windowC,'writeAttachments',{});
  assert.equal((await command(windowC,'read')).draft,null,'A pending or retried handoff cannot restore sent text');
  await command(windowC,'adopt',transfer);
  assert.equal((await command(windowC,'read')).draft,null);
  assert.deepEqual((await command(windowC,'readAttachments')).drafts,{});
  configC.branch='another';
  await assert.rejects(command(windowC,'adopt',transfer),/already moved/,'A consumed transfer cannot be replayed on another branch');
  shared.delete(transferKey);
  // A collision keeps the existing destination draft and the source unchanged.
  const collision={...transfer,draftTransferId:require('node:crypto').randomUUID()};
  await command(windowA,'write',collision.draft);
  const windowD=scope('file:///shared/destination',shared,{workspace:'/windows/d.code-workspace',branch:'topic'});
  await command(windowD,'write','Independent destination work');
  await assert.rejects(command(windowD,'adopt',collision),/already have an unsent draft/);
  assert.equal((await command(windowD,'read')).draft,'Independent destination work');
  assert.equal((await command(windowA,'read')).draft,collision.draft);
  const newerSourcePlan={...collision,draftTransferId:require('node:crypto').randomUUID()};
  await command(windowA,'write','Newer source work');
  const windowE=scope('file:///shared/destination',shared,{workspace:'/windows/e.code-workspace',branch:'topic'});
  await command(windowE,'adopt',newerSourcePlan);
  assert.equal((await command(windowE,'read')).draft,newerSourcePlan.draft);
  assert.equal((await command(windowA,'read')).draft,'Newer source work','Retiring a transfer cannot erase newer source edits');

  const listeners={},ipc=[];
  const native=Object.freeze({getState:()=>({keep:true}),setState:value=>value,postMessage:message=>ipc.push(message)});
  const bridgeWindow={localStorage:store,acquireVsCodeApi:()=>native,addEventListener:(name,listener)=>{listeners[name]=listener;}};
  vm.runInNewContext(webJs,{Storage,window:bridgeWindow});
  const bridge=bridgeWindow.acquireVsCodeApi();
  listeners.message({data:{type:'persisted-atom-sync',scmToolkitDraftScope:scopeMain}});
  bridge.postMessage({type:'persisted-atom-update',key:atomV2,value:{}});
  assert.equal(ipc.at(-1).scmToolkitDraftScope,scopeMain,'Queued writes carry their original rendered scope');
  bridge.postMessage({type:'unrelated',value:'keep'});
  assert.equal(ipc.at(-1).scmToolkitDraftScope,undefined);
  assert.equal(bridge.getState().keep,true);

  const gitRoot=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'codex-draft-branch-'));
  try {
    const git=(...args)=>require('node:child_process').execFileSync('git',args,{cwd:gitRoot,stdio:'pipe'});
    git('init','-b','main');
    const gitVscode={workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:gitRoot,toString:()=>gitRoot}}]}};
    assert.equal((await branchScopes(gitVscode))[0][1],'refs/heads/main');
    git('symbolic-ref','HEAD','refs/heads/topic');
    assert.equal((await branchScopes(gitVscode))[0][1],'refs/heads/topic','Scope follows actual Git HEAD');
  } finally {fs.rmSync(gitRoot,{recursive:true,force:true});}
  console.log('Codex repository-scoped draft IPC and fallback tests passed.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
