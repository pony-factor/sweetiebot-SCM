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
  if (configuration.storage) context.globalStorageUri = { fsPath: configuration.storage };
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
    handleMessage(webview,message) {
      if (message.type === 'persisted-atom-sync-request') return this.sendPersistedAtomState(webview);
      forwarded.push(message);
      return message;
    }
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
  const a = providerFor(repoA), b = providerFor(repoB);
  const atom = 'composer-prompt-drafts-v1';
  const atomV2 = 'composer-prompt-drafts-v2';
  const retained = 'composer-retained-documents-v1';
  const attachmentAtom = 'sweetiebot-composer-attachments-v1';
  const thread = 'local:thread-id';
  const slot = 'new-conversation';
  const rich = { prompt: { document: { type: 'doc', content: [{ type: 'text', text: 'Home A' }] },
    plainTextMode: false }, pullRequestChecks: [], usedDictation: true };
  const threadA = { prompt: 'Thread A', pullRequestChecks: [] };
  const threadB = { prompt: 'Thread B', pullRequestChecks: [] };
  const update = (view, key, fields) => {
    const snapshot = view.seen.findLast(message => message.type === 'persisted-atom-sync');
    return view.provider.handleMessage(view.webview, {
      type: 'persisted-atom-update', key, ...fields,
      scmToolkitDraftScope: snapshot?.scmToolkitDraftScope,
      scmToolkitDraftGeneration: snapshot?.scmToolkitDraftGeneration
    });
  };
  const record = (view, key, entries) => update(view, key, {
    recordUpdate: { entries, ...(key === atomV2 ? { legacyStorageKey: atom } : {}) }
  });
  const originalState = { feature: true, [atomV2]: { [slot]: 'Shared home', [thread]: 'Shared thread' },
    [retained]: { [slot]: 'Shared retained document' },
    'draft-thread-identities-v1': { [slot]: 'Shared pending thread' } };
  const sync = async view => {
    await view.webview.postMessage({ type: 'persisted-atom-sync', state: originalState });
    return view.seen.at(-1).state;
  };
  for (const view of [a, b]) {
    const state = await sync(view);
    assert(!Object.hasOwn(state, atomV2));
    assert(!Object.hasOwn(state, retained));
    assert(!Object.hasOwn(state, 'draft-thread-identities-v1'));
    assert.equal(state.feature, true);
  }
  await update(a, atom, { value: { [slot]: rich } });
  await record(a, atomV2, { [thread]: { value: threadA } });
  await record(b, atomV2, { [slot]: { value: { prompt: 'Home B' } }, [thread]: { value: threadB } });
  const doc = { document: { type: 'doc' }, prompt: 'Home A retained' };
  await record(a, retained, { [slot]: { value: doc }, [thread]: { value: { prompt: 'Thread A retained' } } });
  const reopened = providerFor(scope('file:///workspace/a', shared));
  assert.deepEqual((await sync(reopened))[atomV2], { [slot]: rich, [thread]: threadA });
  assert.deepEqual((await sync(b))[atomV2], { [slot]: { prompt: 'Home B' }, [thread]: threadB });
  assert.deepEqual((await sync(a))[retained], { [slot]: doc, [thread]: { prompt: 'Thread A retained' } });
  assert.equal((await sync(b))[retained], undefined);
  assert.equal(originalState[atomV2][slot], 'Shared home');
  const before = b.seen.length;
  await b.webview.postMessage({ type: 'persisted-atom-updated', key: atomV2, value: originalState[atomV2] });
  assert.equal(b.seen.length, before, 'Ignore stale account-wide broadcasts');
  assert.deepEqual(a.forwarded, [], 'No composer data is written to the shared store');
  await a.provider.handleMessage(a.webview, { type: 'persisted-atom-update', key: 'unrelated', value: 'keep' });
  assert.equal(a.forwarded.at(-1).value, 'keep');
  assert.deepEqual(await noRepo.vscode.commands.executeCommand('sweetiebot.codexDraft.read'), { enabled: false });
  assert.equal(await noRepo.vscode.commands.executeCommand('sweetiebot.codexDraft.write', 'ignored'), false);

  const newer = { prompt: 'New unsent draft', pullRequestChecks: [] };
  await record(a, atomV2, { [slot]: { value: newer }, [thread]: { value: 'updated thread' } });
  await record(a, atomV2, { [slot]: { delete: true, expectedValue: rich } });
  assert.deepEqual((await sync(a))[atomV2][slot], newer, 'Do not delete a newer draft');
  await record(a, retained, { [slot]: { value: doc, expectedValue: doc,
    deleteIfRecordEntryMatches: { recordKey: atomV2, entryKey: slot, expectedValue: newer } } });
  assert(!Object.hasOwn((await sync(a))[retained], slot), 'Discard redundant retained document');
  await record(a, atomV2, { [slot]: { delete: true, expectedValue: newer } });
  assert.deepEqual((await sync(reopened))[atomV2], { [thread]: 'updated thread' }, 'Sending home leaves the thread draft');
  await record(a, retained, { [thread]: null });
  assert.deepEqual(Object.keys((await sync(a))[retained]), []);

  // A send can remove the prompt before the native editor's separate retained
  // document update reaches this host. Retire the matching copy in one write.
  const equivalentDocument = { ...rich.prompt, prompt: 'Home A' };
  const newerThreadDocument = { document: { type: 'doc', content: [{ type: 'text', text: 'New typing' }] },
    plainTextMode: false, prompt: 'New typing' };
  await record(a, atomV2, { [slot]: { value: rich }, [thread]: { value: rich } });
  await record(a, retained, { [slot]: { value: equivalentDocument }, [thread]: { value: newerThreadDocument } });
  await record(a, atomV2, { [slot]: { delete: true, expectedValue: newer } });
  assert.deepEqual((await sync(a))[retained][slot], equivalentDocument, 'A rejected delete cannot retire the document');
  await record(a, atomV2, { [slot]: { delete: true, expectedValue: rich }, [thread]: { delete: true, expectedValue: rich } });
  const afterSend = await sync(reopened);
  assert.deepEqual(Object.keys(afterSend[atomV2]), [], 'The sent prompt stays cleared on reopen');
  assert(!Object.hasOwn(afterSend[retained], slot), 'The same document cannot restore sent text');
  assert.deepEqual(afterSend[retained][thread], newerThreadDocument, 'Keep a separate newer edit');

  const memory = new Map(Object.entries(originalState).map(([key, value]) =>
    ['codex:persisted-atom:' + key, JSON.stringify(value)]));
  memory.set('other', 'keep');
  class Storage {
    getItem(key) { return memory.get(key) ?? null; }
    setItem(key, value) { memory.set(key, String(value)); }
    removeItem(key) { memory.delete(key); }
  }
  const store = new Storage();
  const webJs = fs.readFileSync(path.join(__dirname, '../../assets/codex/drafts-webview.js'), 'utf8');
  vm.runInNewContext(webJs, { Storage, window: { localStorage: store } });
  for (const atomKey of [atom, atomV2, retained, 'draft-thread-identities-v1', attachmentAtom]) {
    const key = 'codex:persisted-atom:' + atomKey;
    const legacy = memory.get(key);
    assert.equal(store.getItem(key), null);
    store.setItem(key, '{"new-conversation":"Do not share"}');
    store.removeItem(key);
    assert.equal(memory.get(key), legacy, 'Legacy values are left intact');
  }
  assert.equal(store.getItem('other'), 'keep');

  const attachmentDrafts = { [slot]: {
    imageAttachments: [{ id:'image-1', src:'data:image/png;base64,aGVsbG8=', localPath:'/tmp/pasted-image.png', filename:'pasted.png' }],
    fileAttachments: ['/workspace/a/report.pdf'],
    uploadedFileAttachments: [{ id:'upload-1', name:'notes.txt', status:'uploaded' }],
    attachmentOrder: ['["image","image-1"]','["file","/workspace/a/report.pdf"]']
  }};
  await update(a, attachmentAtom, { value: attachmentDrafts });
  assert.deepEqual((await sync(reopened))[attachmentAtom], attachmentDrafts, 'Attachments survive reopening');
  assert.deepEqual(Object.keys((await sync(b))[attachmentAtom]), []);
  const destination = scope('file:///workspace/c', shared);
  const workspace = '/workspace/c/draft.code-workspace';
  destination.vscode.workspace.workspaceFile = { fsPath: workspace };
  shared.set(require('../../extension/codex/workspace-handoff').keyFor(workspace), {
    source: '/workspace/a', destination: '/workspace/c', attachmentDrafts
  });
  assert.equal((await sync(providerFor(destination)))[attachmentAtom][slot].fileAttachments[0], '/workspace/c/report.pdf');
  const failing = scope('file:///workspace/failing');
  failing.context.globalState.update = async () => { throw new Error('Storage unavailable'); };
  const failingProvider = providerFor(failing);
  await sync(failingProvider);
  await assert.rejects(update(failingProvider, attachmentAtom, { value: attachmentDrafts }), /Storage unavailable/);
  await assert.rejects(failing.vscode.commands.executeCommand('sweetiebot.codexDraft.readAttachments'), /Storage unavailable/);
  const attachmentHost=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../assets/codex/composer/attachments.js'),'utf8'),attachmentHost);
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
  assert.equal(liveA.seen.at(-1).state[atomV2]?.['new-conversation'], undefined,'A branch refresh replaces the visible old-branch draft');
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
  configA.branch = 'topic';
  const rendererSync = renderer => liveA.provider.handleMessage(liveA.webview,
    { type: 'persisted-atom-sync-request', scmToolkitDraftRenderer: renderer });
  await rendererSync('previous-renderer');
  configA.branch = 'main';
  liveA.webview.html = '<html>Coded editor</html>';
  liveA.provider.scmToolkitReadDraftThread = async view => {
    assert.equal(view, liveA.webview);
    return '4ad80a10-27cb-4175-93de-222222222222';
  };
  await command(windowA, 'refresh');
  assert.match(liveA.webview.html, /sweetiebot-draft-refresh 1/, 'Changing scope rebuilds the mounted editor');
  await rendererSync('previous-renderer');
  assert.notEqual(liveA.seen.at(-1).scmToolkitDraftScope, scopeMain, 'A stale renderer cannot hydrate the new scope');
  await rendererSync('next-renderer');
  assert.equal(liveA.seen.at(-1).scmToolkitDraftThread, undefined, 'Wait for the native router before restoring the thread');
  await liveA.provider.handleMessage(liveA.webview, { type: 'ready', scmToolkitDraftRenderer: 'next-renderer' });
  await rendererSync('next-renderer');
  assert.equal(liveA.seen.at(-1).scmToolkitDraftThread, '4ad80a10-27cb-4175-93de-222222222222');
  assert.equal(liveA.seen.at(-1).scmToolkitDraftScope, scopeMain);
  assert.equal(liveA.seen.at(-1).state[atom]['new-conversation'], 'Window A main draft');

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

  const threadId = '4ad80a10-27cb-4175-93de-222222222222';
  const selectedThread = 'local:' + threadId;
  const independentThread = 'local:another-thread';
  const sourceView = providerFor(windowA);
  await sync(sourceView);
  await record(sourceView, atomV2, { [selectedThread]: { value: threadA }, [independentThread]: { value: threadB } });
  await record(sourceView, retained, { [selectedThread]: { value: doc } });
  const sourceAtoms = await command(windowA, 'readAtoms');
  const composerDrafts = require('../../extension/codex/drafts').handoffDraftAtoms(sourceAtoms.atoms, threadId);
  assert.deepEqual(composerDrafts[atomV2], { [selectedThread]: threadA });
  await command(windowD, 'adopt', { ...transfer, draft: null, attachmentDrafts: undefined, composerDrafts,
    draftGeneration: sourceAtoms.generation, draftTransferId: require('node:crypto').randomUUID() });
  assert.equal((await command(windowD, 'read')).draft, 'Independent destination work');
  assert.deepEqual((await command(windowD, 'readAtoms')).atoms[atomV2][selectedThread], threadA);
  assert.deepEqual((await command(windowD, 'readAtoms')).atoms[retained][selectedThread], doc);
  const remaining = (await command(windowA, 'readAtoms')).atoms;
  assert.equal(remaining[atomV2][slot], 'Newer source work');
  assert.deepEqual(remaining[atomV2][independentThread], threadB);
  assert(!Object.hasOwn(remaining[atomV2], selectedThread));

  const listeners={},ipc=[];
  const native=Object.freeze({getState:()=>({keep:true}),setState:value=>value,postMessage:message=>ipc.push(message)});
  const bridgeWindow={localStorage:store,acquireVsCodeApi:()=>native,addEventListener:(name,listener)=>{listeners[name]=listener;}};
  vm.runInNewContext(webJs,{Storage,window:bridgeWindow});
  const bridge=bridgeWindow.acquireVsCodeApi();
  listeners.message({data:{type:'persisted-atom-sync',scmToolkitDraftScope:scopeMain}});
  bridge.postMessage({type:'persisted-atom-update',key:atomV2,value:{}});
  assert.equal(ipc.at(-1).scmToolkitDraftScope,scopeMain,'Queued writes carry their original rendered scope');
  const beforeSendWrite = ipc.at(-1);
  bridge.postMessage({ type: 'persisted-atom-update', key: atomV2,
    recordUpdate: { entries: { [slot]: { delete: true } } } });
  const afterSendWrite = ipc.at(-1);
  const deliver = (key, write) => {
    let stopped = false;
    listeners.message({ data: { ...write, type: 'persisted-atom-updated', key },
      stopImmediatePropagation() { stopped = true; } });
    return stopped;
  };
  assert(deliver(atomV2, beforeSendWrite), 'A delayed echo of the typed text must not undo the clear');
  assert(!deliver(atomV2, afterSendWrite), 'Accept the latest persisted clear');
  bridge.postMessage({ type: 'persisted-atom-update', key: retained, value: { [slot]: doc } });
  assert(deliver(retained, afterSendWrite), 'A send cannot overwrite an editor document typed afterward');
  assert(!deliver(atomV2, { ...beforeSendWrite, scmToolkitDraftRenderer: 'different-renderer' }),
    'A different pane still receives the scoped state');
  bridge.postMessage({type:'unrelated',value:'keep'});
  assert.equal(ipc.at(-1).scmToolkitDraftScope,undefined);
  assert.equal(bridge.getState().keep,true);

  const storage = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codex-draft-storage-'));
  try {
    const first = scope('file:///shared/main', new Map(), configA);
    const second = scope('file:///shared/main', new Map(), { ...configB, storage });
    await command(first, 'write', 'A previous scoped draft');
    const firstLocal = scope('file:///shared/main', first.saved, { ...configA, storage });
    assert.equal((await command(firstLocal, 'read')).draft, 'A previous scoped draft');
    await command(first, 'write', 'A on disk');
    await Promise.all([
      command(firstLocal, 'write', 'Buffered A edit'),
      command(second, 'write', 'Buffered B edit')
    ]);
    const reopened = scope('file:///shared/main', new Map(), { ...configA, storage });
    assert.equal((await command(reopened, 'read')).draft, 'Buffered A edit');
    assert.equal((await command(second, 'read')).draft, 'Buffered B edit');
    assert.deepEqual(fs.readdirSync(path.join(storage, 'codex-drafts')).map(file =>
      fs.statSync(path.join(storage, 'codex-drafts', file)).mode & 0o777), [0o600, 0o600]);
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }

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
