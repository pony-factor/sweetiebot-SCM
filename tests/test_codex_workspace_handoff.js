'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { registerCodexWorkspaceHandoff, keyFor } = require('../efs/codex_workspace_handoff');

(async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-handoff-test-')));
  try {
    const from = path.join(temporary, 'main'), destination = path.join(temporary, 'topic');
    await fs.mkdir(from); await fs.mkdir(destination);
    const threadId = '019c56c3-06fc-7db3-a928-9c3607e17129';
    const commands = new Map(), providers = new Map(), requests = [], routes = [];
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
        } else if (method === 'turn/start') {
          assert.equal(params.threadId, threadId); assert.equal(params.cwd, destination); result = { turn: { id: 'continued-turn' } };
        } else assert.fail(method);
        queueMicrotask(() => providers.get(name)?.onResult({ id, result }));
      },
      sendRequest(...args) { this.sendProviderRequest(...args); }
    };
    const vscode = { commands: {
      registerCommand(id, fn) { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
      async executeCommand(id, ...args) {
        if (id === 'sweetiebot.readCodexIdentity') return identity;
        if (id === 'chatgpt.openSidebar') return;
        return commands.get(id)(...args);
      }
    } };
    const provider = { codexMcpConnection: connection, navigateToRoute: route => routes.push(route) };
    const context = vm.createContext({ require, setTimeout, clearTimeout, Date });
    vm.runInContext(await fs.readFile(path.join(__dirname, '../assets/codex/workspace-handoff-host.js'), 'utf8'), context);
    const disposable = context.scmToolkitRegisterCodexWorkspaceHandoff(provider, vscode);
    const prepare = commands.get('sweetiebot.codex.prepareWorkspaceHandoff');
    const resume = commands.get('sweetiebot.codex.resumeWorkspaceHandoff');
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
    disposable.dispose();

    const workspace = path.join(temporary, 'workspace.code-workspace');
    const state = new Map([[keyFor(workspace), { ...plan, destination, draft: 'Unsent draft' }]]);
    const tasks = [], errors = [], resumed = [], drafts = [];
    const globalState = { get: key => state.get(key), async update(key, value) { state.set(key, value); } };
    const editor = {
      workspace: { workspaceFile: { fsPath: workspace }, workspaceFolders: [{ uri: { scheme: 'file', fsPath: destination } }] },
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
    console.log('Same-chat interruption, verified cwd resume, stale frontend guard and draft handoff passed.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
