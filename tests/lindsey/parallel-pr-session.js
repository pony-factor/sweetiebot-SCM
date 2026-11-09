'use strict';

async function localPrompt(address) {
  const callback = new URLSearchParams(new URL(address).hash.slice(1)).get('return_to');
  return new Promise((resolve, reject) => {
    require('node:http').get(callback + '/prompt', response => {
      let body = ''; response.on('data', chunk => {body += chunk;});
      response.on('end', () => {try {resolve(JSON.parse(body).prompt);} catch(error){reject(error);}});
    }).on('error', reject);
  });
}

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const moduleRoot = path.resolve(__dirname, process.env.LINDSEY_MODULE_ROOT || '../../extension');
const { launchMergeSession, resumePRSession, launchBlockerWebSession } = require(moduleRoot + '/github/pr-session');

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
    const calls = [], tabs = [], tabListeners=new Set();
    let maximumTabs=0;
    let workspace, dashboardOptions, recorded, dashboardCount=0;
    const config = () => ({ get: (key, fallback) => fallback, inspect:()=>({}), update:async()=>{} });
    const vscode = { Uri: { file }, ConfigurationTarget:{Workspace:2}, ProgressLocation: { Notification: 15 }, ViewColumn: { One: 1, Two: 2 },
      workspace: { getConfiguration: config, onDidChangeConfiguration: () => ({ dispose() {} }), workspaceFolders: [{ uri: file(root) }] },
      window: { tabGroups: { all: [{ viewColumn: 1, tabs }],
        close:async tab=>{const index=tabs.indexOf(tab);if(index>=0)tabs.splice(index,1);for(const fn of tabListeners)fn();return true;},
        onDidChangeTabs:fn=>{tabListeners.add(fn);return {dispose:()=>tabListeners.delete(fn)};}
      },
        withProgress: async (options, task) => task({ report() {} }) },
      authentication: { getSession: async () => ({ accessToken: 'fixture-token' }) },
      commands: { executeCommand: async (command, options) => {
        calls.push([command, options]);
        if (command === 'vscode.openFolder') workspace = options;
        if (command === 'workbench.action.browser.open') {tabs.push({ label: 'GPT review ' + (tabs.length + 1) });maximumTabs=Math.max(maximumTabs,tabs.length);}
      } }
    };
    require.cache[dashboardPath] = { ...dashboardModule, exports: { ...dashboardExports,
      startMergeDashboard(host, selected, token, options) {
        dashboardCount++;
        assert.equal(selected.pullRequests.length, 11); dashboardOptions = options;
        return { recordBatchState(state) { recorded = state; },recordRepairWorker() {},recordLocalResult() {} };
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
    const requestPath = path.join(path.dirname(workspace.fsPath), 'request.json');
    const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    await fs.writeFile(requestPath, JSON.stringify({ ...request, resumeSelection: {
      ...selection, repository: 'other/repo', pullRequests: selection.pullRequests.map(pr => ({ ...pr,
        url: pr.url.replace('owner/repo', 'other/repo') }))
    } }));
    await assert.rejects(resumePRSession(vscode, context), /outside the original merge session/);
    for (const pr of selection.pullRequests) pr.headSha = 'c'.repeat(40);
    await fs.writeFile(requestPath, JSON.stringify({ ...request, resumeSelection: selection }));
    await resumePRSession(vscode, context);
    const originalSelection = JSON.parse(await fs.readFile(path.join(path.dirname(workspace.fsPath), 'merge-selection.json'), 'utf8'));
    assert(originalSelection.pullRequests.every(pr => pr.headSha === 'a'.repeat(40)), 'Recovery preserves original dashboard snapshots');
    const launches = calls.filter(([command]) => command === 'workbench.action.browser.open');
    assert.equal(launches.length, 3, 'Large independent queues open three GPT sessions');
    const assigned = [];
    for (const [, options] of launches) {
      const prompt = await localPrompt(options.url);
      assert(prompt.includes('PARALLEL REVIEW LANE'));
      const snapshot = prompt.match(/Refreshed selected snapshots: (\[[^\n]+\])/)[1];
      assert(JSON.parse(snapshot).every(pr => pr.headSha === 'c'.repeat(40)), 'Explicit recovery reviews the current heads');
      assigned.push(...JSON.parse(snapshot).map(pr => pr.number));
    }
    assert.equal(assigned.length, 11); assert.equal(new Set(assigned).size, 11);
    assert.equal(recorded.workers.length, 3);
    await dashboardOptions.onFocusWorker(2);
    assert.deepEqual(calls.slice(-2).map(([command]) => command),
      ['workbench.action.focusFirstEditorGroup', 'workbench.action.openEditorAtIndex2']);
    await resumePRSession(vscode, context);
    assert.equal(calls.filter(([command]) => command === 'workbench.action.browser.open').length, 3,
      'Restoring a dashboard does not resubmit the three merge chats');
    const repairLaunches=Array.from({length:4},(_,index)=>launchBlockerWebSession(vscode,context,file(root),
      'https://chatgpt.com/#sweetiebot_merge=1&q=Resolve+compatible+conflicts',index+1,
      {...selection,pullRequests:[selection.pullRequests[index]]}));
    const handles=await Promise.all(repairLaunches.slice(0,3));
    assert.equal(tabs.length,6,'Three conflict chats run alongside the three reviewers');
    assert.equal(calls.filter(([command])=>command==='vscode.openFolder').length,1,
      'Parallel conflict repairs stay in the existing bulk window');
    for(const [,options] of calls.filter(([command])=>command==='workbench.action.browser.open').slice(3)) {
      const prompt=await localPrompt(options.url);
      assert(prompt.includes('BRANCH-ONLY EXECUTION'),'A repair chat cannot merge or close its PR');
    }
    await vscode.window.tabGroups.close(handles[0].tab,true);
    handles.push(await repairLaunches[3]);
    assert.equal(maximumTabs,6,'A fourth repair waits for a free chat slot');
    for(const handle of handles)handle.dispose();
    await Promise.all(handles.map(handle=>handle.done));
    assert.equal(tabs.length,3,'Finishing repairs retains all three review chats');
    const openedBeforeRestore=calls.filter(([command])=>command==='workbench.action.browser.open').length;
    dashboardOptions.onClose();
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(dashboardCount,2,'Closing the report restores one persistent dashboard');
    assert.equal(calls.filter(([command])=>command==='workbench.action.browser.open').length,openedBeforeRestore,
      'Restoring the center report never relaunches or replays chats');
    console.log('Three independent GPT tabs, dashboard status, tab focus and restore checks passed.');
  } finally {
    globalThis.fetch = originalFetch;
    require.cache[dashboardPath] = dashboardModule;
    for (const item of context.subscriptions) item.dispose();
    require('../../extension/merge/handoff-proxy').shutdownHandoffProxy();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
