'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { registerCodexWorkspaceHandoff, keyFor } = require('../extension/codex/codex_workspace_handoff');

(async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-handoff-test-')));
  try {
    const from = path.join(temporary, 'main'), destination = path.join(temporary, 'topic');
    await fs.mkdir(from); await fs.mkdir(destination);
    const threadId = '019c56c3-06fc-7db3-a928-9c3607e17129';
    const newThreadId = '019c56c3-06fc-7db3-a928-9c3607e17130';
    const commands = new Map(), providers = new Map(), requests = [], routes = [], opened = [];
    let active = true, wrongCwd = false, wrongThread = false, identity = { threadId };
    const connection = {
      registerProvider(name, callbacks) { providers.set(name, callbacks); return { dispose() { providers.delete(name); } }; },
      sendProviderRequest(name, id, method, params) {
        requests.push({ method, params });
        let result;
        if (method === 'thread/read') {
          assert.equal(params.includeTurns, false, 'Never hydrate conversation contents for a handoff');
          result = { thread: { id: wrongThread ? 'another-chat' : threadId, cwd: from, status: { type: active ? 'active' : 'idle' } } };
        } else if (method === 'thread/turns/list') {
          assert.equal(params.itemsView, 'notLoaded');
          result = { data: [{ id: 'running-turn', status: 'inProgress' }] };
        } else if (method === 'turn/interrupt') {
          assert.equal(params.turnId, 'running-turn'); active = false; result = {};
        } else if (method === 'thread/resume') {
          result = { cwd: wrongCwd ? from : params.cwd, thread: { id: threadId, status: { type: 'idle' } } };
          assert(!('approvalPolicy' in params), 'Preserve the existing permission policy');
        } else if (method === 'thread/start') {
          assert.equal(params.cwd, destination);
          assert(!('approvalPolicy' in params));
          result = { thread: { id: newThreadId, cwd: wrongCwd ? from : destination } };
        } else if (method === 'turn/start') {
          assert([threadId, newThreadId].includes(params.threadId)); assert.equal(params.cwd, destination); result = { turn: { id: 'continued-turn' } };
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
    vm.runInContext(await fs.readFile(path.join(__dirname, '../assets/codex/workspace-handoff-host.js'), 'utf8'), context);
    const disposable = context.scmToolkitRegisterCodexWorkspaceHandoff(provider, vscode);
    const prepare = commands.get('sweetiebot.codex.prepareWorkspaceHandoff');
    const resume = commands.get('sweetiebot.codex.resumeWorkspaceHandoff');
    const openCheckout = commands.get('sweetiebot.codex.openChatCheckout');
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
    const plan = await prepare({ from });
    assert.equal(plan.threadId, threadId); assert.equal(plan.wasActive, true);
    assert(requests.some(request => request.method === 'turn/interrupt'));
    assert(!requests.some(request => request.method === 'turn/start'), 'Do not continue in the old host');
    await resume({ ...plan, destination });
    assert.deepEqual(routes, ['/local/' + threadId]);
    assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
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
    disposable.dispose();

    const workspace = path.join(temporary, 'workspace.code-workspace');
    const state = new Map([[keyFor(workspace), { ...plan, destination, draft: 'Unsent draft' }]]);
    const tasks = [], errors = [], resumed = [], drafts = [];
    const globalState = { get: key => state.get(key), async update(key, value) { state.set(key, value); } };
    let foldersChanged;
    const editor = {
      workspace: { workspaceFile: { fsPath: workspace }, workspaceFolders: [{ uri: { scheme: 'file', fsPath: destination } }],
        onDidChangeWorkspaceFolders(callback) { foldersChanged = callback; return { dispose() {} }; } },
      extensions: { getExtension: () => ({ async activate() {} }) },
      commands: { registerCommand() { return { dispose() {} }; }, async executeCommand(id, value) {
        if (id === 'sweetiebot.codexDraft.write') drafts.push(value);
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
    assert.equal(errors.length, 0);
    console.log('Same-chat interruption, verified cwd resume, stale frontend guard and draft handoff passed.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
