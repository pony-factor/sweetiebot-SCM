'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const moduleRoot = path.resolve(__dirname, process.env.LINDSEY_MODULE_ROOT || '../extension');
const { launchMergeSession, resumePRSession } = require(moduleRoot + '/github/pr_session');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-pr-session-'));
  const originalFetch = globalThis.fetch;
  const dashboardPath = require.resolve(moduleRoot + '/merge/dashboard');
  const dashboardModule = require.cache[dashboardPath];
  const dashboardExports = require(moduleRoot + '/merge/dashboard');
  const context = { globalStorageUri: { fsPath: temporary }, subscriptions: [] };
  try {
    const root = path.join(temporary, 'repo');
    await fs.mkdir(root); execFileSync('git', ['init', '--quiet', root]);
    const file = fsPath => ({ scheme: 'file', fsPath });
    const selection = { repository: 'owner/repo', pullRequests: Array.from({ length: 11 }, (_, index) => ({
      number: index + 1, title: 'Feature ' + (index + 1), url: 'https://github.com/owner/repo/pull/' + (index + 1),
      head: 'feature-' + (index + 1), headSha: 'a'.repeat(40), base: 'main'
    })) };
    const calls = [], tabs = [];
    let workspace, dashboardOptions, recorded;
    const config = () => ({ get: (key, fallback) => fallback, inspect:()=>({}), update:async()=>{} });
    const vscode = { Uri: { file }, ConfigurationTarget:{Workspace:2}, ProgressLocation: { Notification: 15 }, ViewColumn: { One: 1, Two: 2 },
      workspace: { getConfiguration: config, onDidChangeConfiguration: () => ({ dispose() {} }), workspaceFolders: [{ uri: file(root) }] },
      window: { tabGroups: { all: [{ viewColumn: 1, tabs }] },
        withProgress: async (options, task) => task({ report() {} }) },
      authentication: { getSession: async () => ({ accessToken: 'fixture-token' }) },
      commands: { executeCommand: async (command, options) => {
        calls.push([command, options]);
        if (command === 'vscode.openFolder') workspace = options;
        if (command === 'workbench.action.browser.open') tabs.push({ label: 'GPT review ' + (tabs.length + 1) });
      } }
    };
    require.cache[dashboardPath] = { ...dashboardModule, exports: { ...dashboardExports,
      startMergeDashboard(host, selected, token, options) {
        assert.equal(selected.pullRequests.length, 11); dashboardOptions = options;
        return { recordBatchState(state) { recorded = state; } };
      } } };
    globalThis.fetch = async address => {
      const pathname = new URL(address).pathname;
      if (pathname.includes('/branches/')) return { ok: true, json: async () => ({ commit: { sha: 'b'.repeat(40) } }) };
      const number = Number(pathname.match(/\/pulls\/(\d+)/)?.[1]);
      const pr = selection.pullRequests.find(pr => pr.number === number);
      assert(pr, pathname);
      const result = pathname.endsWith('/files') ? [{ filename: 'feature-' + number + '.js' }] : {
        state: 'open', draft: false, title: pr.title,
        head: { ref: pr.head, sha: pr.headSha, repo: { full_name: selection.repository } }, base: { ref: pr.base }
      };
      return { ok: true, json: async () => result };
    };
    await launchMergeSession(vscode, context, file(root), 'https://chatgpt.com/#sweetiebot_merge=1&q=Review', selection);
    vscode.workspace.workspaceFile = workspace;
    await resumePRSession(vscode, context);
    const launches = calls.filter(([command]) => command === 'workbench.action.browser.open');
    assert.equal(launches.length, 3, 'Large independent queues open three GPT sessions');
    const assigned = launches.flatMap(([, options]) => {
      const prompt = new URLSearchParams(new URL(options.url).hash.slice(1)).get('q');
      assert(prompt.includes('PARALLEL REVIEW LANE'));
      const snapshot = prompt.match(/Refreshed selected snapshots: (\[[^\n]+\])/)[1];
      return JSON.parse(snapshot).map(pr => pr.number);
    });
    assert.equal(assigned.length, 11); assert.equal(new Set(assigned).size, 11);
    assert.equal(recorded.workers.length, 3);
    await dashboardOptions.onFocusWorker(2);
    assert.deepEqual(calls.slice(-2).map(([command]) => command),
      ['workbench.action.focusFirstEditorGroup', 'workbench.action.openEditorAtIndex2']);
    await resumePRSession(vscode, context);
    assert.equal(calls.filter(([command]) => command === 'workbench.action.browser.open').length, 3,
      'Restoring a dashboard does not resubmit the three merge chats');
    console.log('Three independent GPT tabs, dashboard status, tab focus and restore checks passed.');
  } finally {
    globalThis.fetch = originalFetch;
    require.cache[dashboardPath] = dashboardModule;
    for (const item of context.subscriptions) item.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
