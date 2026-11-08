'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { prepareCodexHandoff, registerCodexWorkspaceHandoff, retryCodexComposerFocus, keyFor, handoffAttachments } = require('../../extension/codex/workspace-handoff');

(async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-handoff-test-')));
  try {
    const from = path.join(temporary, 'main'), destination = path.join(temporary, 'topic');
    await fs.mkdir(from); await fs.mkdir(destination);
    const threadId = '019c56c3-06fc-7db3-a928-9c3607e17129';
    const newThreadId = '019c56c3-06fc-7db3-a928-9c3607e17130';
    const commands = new Map(), providers = new Map(), requests = [], routes = [], opened = [];
    let active = true, wrongCwd = false, wrongThread = false, identity = { threadId }, turnStatus = 'inProgress';
    const connection = {
      registerProvider(name, callbacks) { providers.set(name, callbacks); return { dispose() { providers.delete(name); } }; },
      sendProviderRequest(name, id, method, params) {
        requests.push({ method, params });
        let result;
        if (method === 'thread/read') {
          assert.equal(params.includeTurns, false, 'Never hydrate conversation contents for a handoff');
          result = { thread: { id: wrongThread ? 'another-chat' : threadId, cwd: from, status: { type: active ? 'active' : 'idle' } } };
        } else if (method === 'account/rateLimits/read') {
          result = { rateLimits: {primary:{usedPercent:100,resetsAt:Math.floor(Date.now()/1000)+600},secondary:{usedPercent:100,resetsAt:Math.floor(Date.now()/1000)+1200}} };
        } else if (method === 'thread/turns/list') {
          assert.equal(params.itemsView, 'notLoaded');
          result = { data: [{ id: 'running-turn', status: turnStatus }] };
        } else if (method === 'turn/interrupt') {
          assert.equal(params.turnId, 'running-turn'); active = false; result = {};
        } else if (method === 'thread/resume') {
          result = { cwd: wrongCwd ? from : params.cwd, thread: { id: threadId, status: { type: 'idle' } } };
          assert(!('approvalPolicy' in params), 'Preserve the existing permission policy');
        } else if (method === 'thread/start') {
          assert.equal(params.cwd, destination);
          assert(!('approvalPolicy' in params));
          result = { thread: { id: newThreadId, cwd: wrongCwd ? from : destination } };
        } else if (method === 'turn/steer') {
          assert.equal(params.expectedTurnId, 'running-turn');
          result = { turnId: 'running-turn' };
        } else if (method === 'turn/start') {
          assert([threadId, newThreadId].includes(params.threadId)); assert([from, destination].includes(params.cwd)); result = { turn: { id: 'continued-turn' } };
        } else assert.fail(method);
        queueMicrotask(() => providers.get(name)?.onResult({ id, result }));
      },
      sendRequest(...args) { this.sendProviderRequest(...args); }
    };
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: destination } }] }, commands: {
      registerCommand(id, fn) { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
      async executeCommand(id, ...args) {
        if (id === 'sweetiebot.readCodexIdentity') return identity;
        if (id === 'chatgpt.openSidebar') return;
        if (id === 'vscode.openFolder') { opened.push(args); return; }
        return commands.get(id)(...args);
      }
    } };
    const provider = { codexMcpConnection: connection, navigateToRoute: route => routes.push(route) };
    const context = vm.createContext({ require, setTimeout, clearTimeout, Date });
    vm.runInContext(await fs.readFile(path.join(__dirname, '../../assets/codex/workspace-handoff-host.js'), 'utf8'), context);
    const disposable = context.scmToolkitRegisterCodexWorkspaceHandoff(provider, vscode);
    const lookup=commands.get('sweetiebot.codex.readRateLimitReset');
    const limits=await lookup({threadId});
    assert(limits.known && limits.limited && limits.resetAt>Date.now()+1100000);
    const lookups=requests.filter(request=>request.method==='account/rateLimits/read').length;
    await lookup({threadId});
    assert.equal(requests.filter(request=>request.method==='account/rateLimits/read').length,lookups,'Reset lookups share a bounded cache');
    assert.equal((await lookup({threadId:'wrong-thread'})).known,false);
    requests.length=0;
    const prepare = commands.get('sweetiebot.codex.prepareWorkspaceHandoff');
    const resume = commands.get('sweetiebot.codex.resumeWorkspaceHandoff');
    const openCheckout = commands.get('sweetiebot.codex.openChatCheckout');
    const visibility = commands.get('sweetiebot.codex.chatCheckoutVisibility');
    assert.equal((await visibility(threadId)).needsNewWindow, true, 'A checkout outside this window needs the shortcut');
    vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: from } }];
    assert.equal((await visibility(threadId)).needsNewWindow, false, 'The current checkout must hide the shortcut');
    await openCheckout(threadId);
    assert.equal(opened.length, 0, 'Do not open a duplicate window for the active checkout');
    vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: destination } }];
    requests.length = 0;
    await assert.rejects(openCheckout('stale-chat'), /visible chat changed/);
    assert.equal(requests.length, 0, 'Reject stale clicks before querying a different chat');
    await openCheckout(threadId);
    assert.equal(opened[0][0].fsPath, from, 'Open the chat cwd, not the current workspace root');
    assert.equal(opened[0][1].forceNewWindow, true);
    assert(requests.every(request => request.method === 'thread/read'), 'Opening must not resume or interrupt the worker');
    wrongThread = true;
    await assert.rejects(openCheckout(threadId), /different chat/);
    assert.equal(opened.length, 1);
    wrongThread = false;
    const beforeUnrelated = requests.length;
    const historical = await prepare({ from: destination });
    assert.equal(historical.threadId, threadId, 'Move the same historical chat with the branch');
    assert.equal(historical.relative, '', 'An outside checkout must map to the destination root');
    assert.equal(historical.oldCwd, from, 'Retain the original worker location for recovery');
    assert.equal(historical.wasActive, true);
    assert.deepEqual(requests.slice(beforeUnrelated).map(request => request.method),
      ['thread/read', 'thread/turns/list', 'turn/interrupt', 'thread/read'],
      'Stop the historical worker before taking over the destination');
    assert.equal(active, false);
    active = true;
    const plan = await prepare({ from });
    assert.equal(plan.threadId, threadId); assert.equal(plan.wasActive, true);
    assert(requests.some(request => request.method === 'turn/interrupt'));
    assert(!requests.some(request => request.method === 'turn/start'), 'Do not continue in the old host');
    const sandbox = path.join(temporary, 'experiment');
    await fs.mkdir(sandbox);
    const notifyExperiment = commands.get('sweetiebot.codex.sendExperimentDirection');
    assert.equal(await notifyExperiment({ source: from, sourceBranch: 'original-topic', destination: sandbox, branch: 'topic' }), true);
    assert.equal(requests.at(-1).method, 'turn/start', 'Idle chats receive the direction without moving their cwd');
    assert.equal(requests.at(-1).params.cwd, from);
    assert(requests.at(-1).params.input[0].text.includes(sandbox));
    assert(requests.at(-1).params.input[0].text.includes('Run tests'));
    const experimentDirection = requests.at(-1).params.input[0].text;
    assert(experimentDirection.includes('Original branch: "original-topic"'));
    assert(experimentDirection.includes('apply the final intended code changes to the original checkout and original branch'));
    assert(experimentDirection.includes('relative to the initial experiment snapshot'));
    assert(experimentDirection.includes('Preserve existing user edits and staging'));
    assert(experimentDirection.includes('Work left only in the trial checkout is not completion'));
    assert(!experimentDirection.includes('copy experimental edits back without explicit permission'));
    active = true;
    const beforeNotice = requests.length;
    assert.equal(await notifyExperiment({ source: from, destination: sandbox, branch: 'topic', expectedThreadId: threadId }), true);
    assert.equal(requests.at(-1).method, 'turn/steer', 'In-flight chats receive a steer, not an interruption');
    assert.equal(requests.at(-1).params.expectedTurnId, 'running-turn');
    assert.deepEqual(requests.slice(beforeNotice).map(request => request.method),
      ['thread/read', 'thread/turns/list', 'turn/steer'],
      'A notice does not resume, interrupt or drain the native follow-up queue');
    const beforeStaleNotice = requests.length;
    await assert.rejects(notifyExperiment({source: from, destination: sandbox, branch: 'topic', expectedThreadId: 'different-chat'}), /original Codex chat changed/);
    assert.equal(requests.length, beforeStaleNotice, 'Reject a stale chat before sending any provider request');
    active = false;
    await assert.rejects(notifyExperiment({ source: destination, destination: sandbox, branch: 'topic' }), /another checkout/);
    assert.equal(await notifyExperiment({ source: from, destination: from, branch: 'topic' }).then(() => false, () => true), true,
      'Never treat the original checkout as a disposable experiment');

    const focus = { threadId, state: { anchor: { path: [], offset: 0 } } };
    const focusAttempts = [];
    const immediate = async () => {};
    const retryFocus = {
      commands: { async executeCommand(id, value) {
        assert.equal(id, 'sweetiebot.codex.restoreComposerFocus');
        assert.equal(value, focus);
        focusAttempts.push(id);
        return focusAttempts.length === 1 ? null : true;
      } }
    };
    assert.equal(await retryCodexComposerFocus(retryFocus, focus, () => true, immediate), true);
    assert.equal(focusAttempts.length, 2, 'Retry an editor that was still hydrating');
    focusAttempts.length = 0;
    const cancelledFocus = { commands: { async executeCommand() { focusAttempts.push('cancel'); return false; } } };
    assert.equal(await retryCodexComposerFocus(cancelledFocus, focus, () => true, immediate), false);
    assert.equal(focusAttempts.length, 1, 'Never retry after the user cancels restoration');
    let timeoutCount = 0;
    const timeoutFocus = { commands: { async executeCommand() {
      if (++timeoutCount === 1) throw new Error('Codex composer focus restoration timed out.');
      return true;
    } } };
    assert.equal(await retryCodexComposerFocus(timeoutFocus, focus, () => true, immediate), true);
    assert.equal(timeoutCount, 2, 'A host timeout is transient rather than a paused handoff');
    const staleFocus = { commands: { async executeCommand() { assert.fail('Stale handoffs must not restore focus'); } } };
    assert.equal(await retryCodexComposerFocus(staleFocus, focus, () => false, immediate), false);

    const beforeResumption = requests.filter(request => request.method === 'turn/start').length;
    await resume({ ...plan, destination });
    assert.deepEqual(routes, ['/local/' + threadId]);
    assert.equal((await visibility(threadId)).needsNewWindow, false,
      'A rebound worker in the current checkout must not show the shortcut');
    assert.equal(requests.filter(request => request.method === 'turn/start').length, beforeResumption + 1);

    await resume({ ...plan, destination, continuationText: 'Try the experiment and run relevant tests here.' });
    assert.equal(requests.at(-1).params.cwd, destination);
    assert.equal(requests.at(-1).params.input[0].text, 'Try the experiment and run relevant tests here.');

    const startsAfterExperiment = requests.filter(request => request.method === 'turn/start').length;
    await resume({ ...plan, destination, wasActive: false, continuationText: 'Try the experiment.' });
    assert.equal(requests.filter(request => request.method === 'turn/start').length, startsAfterExperiment,
      'A consumed experiment handoff must not submit its instruction again');

    const focusFollowUps = [];
    commands.set('sweetiebot.codexHandoff.restoreFocusWhenReady', value => {
      focusFollowUps.push(value);
      return Promise.resolve();
    });
    const turnsBeforeFocus = requests.filter(request => request.method === 'turn/start').length;
    await resume({ ...plan, destination, wasActive: false, composerFocus: focus.state });
    assert.equal(focusFollowUps.length, 1, 'Schedule editor focus after resuming a chat');
    assert.equal(focusFollowUps[0].threadId, threadId);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, turnsBeforeFocus,
      'A focus-only restoration must not replay the chat continuation');
    commands.set('sweetiebot.codexHandoff.restoreFocusWhenReady', async () => {
      throw new Error('Focus UI is temporarily unavailable');
    });
    await resume({ ...plan, destination, wasActive: false, composerFocus: focus.state });

    connection.sendProviderRequest('frontend', 'frontend-request', 'thread/resume', { threadId, cwd: from });
    assert.equal(requests.at(-1).params.cwd, destination, 'A stale frontend resume cannot reattach the worker to main');

    wrongCwd = true;
    const before = requests.filter(request => request.method === 'turn/start').length;
    await assert.rejects(resume({ ...plan, destination }), /did not resume the same chat/);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, before);
    wrongCwd = false; wrongThread = true;
    await assert.rejects(prepare({ from }), /different chat/);
    wrongThread = false; identity = { threadId: null };
    assert.equal(await prepare({ from }), null);
    const startTask = commands.get('sweetiebot.codex.startBlockerTask');
    await assert.rejects(startTask({ cwd: from, prompt: 'Selected task' }), /does not match/);
    const startedTask = await startTask({ cwd: destination, prompt: 'Keep main and add the proposed features.' });
    assert.equal(startedTask.threadId, newThreadId, 'Implementation uses a new chat');
    assert.equal(requests.at(-1).params.input[0].text, 'Keep main and add the proposed features.');
    wrongCwd = true;
    const tasksBeforeWrongCwd = requests.filter(request => request.method === 'turn/start').length;
    await assert.rejects(startTask({ cwd: destination, prompt: 'Selected task' }), /did not confirm/);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, tasksBeforeWrongCwd);
    wrongCwd = false;
    identity = { threadId };
    const continueAtReset = commands.get('sweetiebot.codex.continueAfterRateLimit');
    turnStatus = 'failed'; active = false;
    const resetAt = Date.now() - 1000;
    const continuationsBefore = requests.filter(request => request.method === 'turn/start').length;
    assert.equal(await continueAtReset({ threadId, resetAt: Date.now() + 60000 }), false, 'Never retry before reset');
    assert.equal(await continueAtReset({ threadId, resetAt }), true);
    assert.equal(await continueAtReset({ threadId, resetAt }), false, 'Do not duplicate an uncertain continuation');
    assert.equal(requests.filter(request => request.method === 'turn/start').length, continuationsBefore + 1);
    turnStatus = 'completed';
    assert.equal(await continueAtReset({ threadId, resetAt: resetAt - 1 }), false, 'Answered requests do not need continuation');
    disposable.dispose();

    const workspace = path.join(temporary, 'workspace.code-workspace');
    const state = new Map([[keyFor(workspace), { ...plan, destination, draft: 'Unsent draft' }]]);
    const tasks = [], errors = [], resumed = [], drafts = [], attachmentWrites = [];
    const globalState = { get: key => state.get(key), async update(key, value) { state.set(key, value); } };
    let foldersChanged;
    const editor = {
      workspace: { workspaceFile: { fsPath: workspace }, workspaceFolders: [{ uri: { scheme: 'file', fsPath: destination } }],
        onDidChangeWorkspaceFolders(callback) { foldersChanged = callback; return { dispose() {} }; } },
      extensions: { getExtension: () => ({ async activate() {} }) },
      commands: { registerCommand() { return { dispose() {} }; }, async executeCommand(id, value) {
        if (id === 'sweetiebot.codexDraft.write') drafts.push(value);
        else if (id === 'sweetiebot.codexDraft.writeAttachments') attachmentWrites.push(value);
        else if (id === 'sweetiebot.codex.resumeWorkspaceHandoff') { resumed.push(value); return { threadId }; }
        else assert.fail(id);
      } },
      window: { showErrorMessage: message => errors.push(message) }
    };
    const previous = global.setImmediate;
    global.setImmediate = task => tasks.push(task);
    try { registerCodexWorkspaceHandoff(editor, { globalState, subscriptions: [] }); }
    finally { global.setImmediate = previous; }
    tasks[0]();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(errors.length, 0);
    const handoffCalls = [];
    await prepareCodexHandoff({
      extensions: { getExtension: () => ({ activate: async () => {} }) },
      commands: {
        getCommands: async () => ['sweetiebot.cancelCodexCapture', 'sweetiebot.codex.prepareWorkspaceHandoff'],
        executeCommand: async id => { handoffCalls.push(id); return null; }
      }
    }, from);
    assert.deepEqual(handoffCalls, ['sweetiebot.cancelCodexCapture', 'sweetiebot.codex.prepareWorkspaceHandoff'],
      'Branch switching cancels exports before preparing the same chat and never requests conversation text');
    const cancellationCalls = [], cancellationWarnings = [];
    const cancelledPlan = await prepareCodexHandoff({
      extensions: { getExtension: () => ({ activate: async () => {} }) },
      window: { showWarningMessage: message => cancellationWarnings.push(message) },
      commands: {
        getCommands: async () => ['sweetiebot.cancelCodexCapture', 'sweetiebot.codex.prepareWorkspaceHandoff'],
        executeCommand: async id => {
          cancellationCalls.push(id);
          if (id === 'sweetiebot.cancelCodexCapture') throw Error('Clipboard restore failed');
          return null;
        }
      }
    }, from);
    assert.equal(cancelledPlan, null);
    assert.deepEqual(cancellationCalls, ['sweetiebot.cancelCodexCapture', 'sweetiebot.codex.prepareWorkspaceHandoff'],
      'A failed copy cancellation must not block the branch handoff or start transcript export');
    assert.match(cancellationWarnings[0], /continuing the branch switch.*Clipboard restore failed/);
    const attachmentDrafts = { 'new-conversation': {
      imageAttachments:[{id:'image',src:'data:image/png;base64,aGVsbG8=',localPath:'/tmp/image.png'}],
      fileAttachments:[path.join(from,'report.pdf')],
      attachmentOrder:[JSON.stringify(['file',path.join(from,'report.pdf')])]
    }};
    const attachmentPlan=await prepareCodexHandoff({
      extensions:{getExtension:()=>({activate:async()=>{}})},
      commands:{getCommands:async()=>['sweetiebot.codex.prepareWorkspaceHandoff','sweetiebot.codexDraft.readAttachments'],
        executeCommand:async id=>id==='sweetiebot.codexDraft.readAttachments'?{enabled:true,drafts:attachmentDrafts}:null}
    },from);
    assert.equal(attachmentPlan.draftOnly,true,'Image-only new chats need a handoff without a thread ID');
    const richDraft={prompt:{document:{type:'doc',content:[]},plainTextMode:false},pullRequestChecks:[]};
    const richPlan=await prepareCodexHandoff({
      extensions:{getExtension:()=>({activate:async()=>{}})},
      commands:{getCommands:async()=>['sweetiebot.codex.prepareWorkspaceHandoff','sweetiebot.codexDraft.read'],
        executeCommand:async id=>id==='sweetiebot.codexDraft.read'?{enabled:true,draft:richDraft}:null}
    },from);
    assert.deepEqual(richPlan.draft,richDraft,'Native v2 rich drafts survive checkout handoff intact');
    const moved=handoffAttachments({...attachmentPlan,destination});
    assert.equal(moved['new-conversation'].fileAttachments[0],path.join(destination,'report.pdf'));
    assert.equal(moved['new-conversation'].attachmentOrder[0],JSON.stringify(['file',path.join(destination,'report.pdf')]));
    assert.deepEqual(moved['new-conversation'].imageAttachments,attachmentDrafts['new-conversation'].imageAttachments);
    assert.equal(attachmentDrafts['new-conversation'].fileAttachments[0],path.join(from,'report.pdf'),'Source attachment state is unchanged');
    assert.equal(resumed[0].threadId, threadId);
    assert.deepEqual(drafts, ['Unsent draft']);
    assert.equal(state.get(keyFor(workspace)), undefined, 'Completed handoffs must not reopen stale chats on reload');
    state.set(keyFor(workspace), { ...plan, destination, draft: 'Draft after folder change' });
    foldersChanged();
    foldersChanged();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(resumed.length, 2, 'Folder changes resume once without a window reload');
    assert.equal(drafts.at(-1), 'Draft after folder change');
    assert.equal(state.get(keyFor(workspace)), undefined);
    foldersChanged();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(resumed.length, 2, 'Later folder events must not reopen the chat');
    state.set(keyFor(workspace), { ...attachmentPlan, destination });
    foldersChanged();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(attachmentWrites.at(-1),moved,'Draft-only navigation restores the full attachment record');
    assert.equal(resumed.length,2,'A new-chat attachment draft must not open or submit an existing conversation');
    assert.equal(state.get(keyFor(workspace)),undefined);
    const draftsBeforeLegacy = drafts.length, resumesBeforeLegacy = resumed.length;
    state.set(keyFor(workspace), {...plan, destination, draft: 'Original draft',
      continuationText: 'The user moved this same chat into a disposable experiment on branch trial-old. Continue here.'});
    foldersChanged();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(state.get(keyFor(workspace)), undefined, 'Retire failed legacy trial migrations on reload');
    assert.equal(resumed.length, resumesBeforeLegacy, 'Do not retry the rejected trial thread/resume');
    assert.equal(drafts.length, draftsBeforeLegacy, 'Do not copy the original draft into a separate trial window');
    assert.equal(errors.length, 0);
    console.log('Same-chat interruption, verified cwd resume, stale frontend guard and draft handoff passed.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
