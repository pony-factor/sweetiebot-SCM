'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { githubRepository, pullRequestPrompt, registerPullRequestCommand } = require('../efs/pull_request');

async function run() {
  for (const remote of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
    assert.equal(githubRepository(remote), 'https://github.com/owner/repo');
  }
  for (const remote of ['https://github.com.attacker.test/owner/repo', 'https://user:password@github.com/owner/repo', 'file:///local', undefined]) {
    assert.equal(githubRepository(remote), undefined);
  }
  const prompt = pullRequestPrompt({ branch: 'draft', repositoryPath: '/repo with spaces', repositoryUrl: 'https://github.com/owner/repo', base: 'main' });
  assert(prompt.includes('in repository https://github.com/owner/repo, against'));
  assert(!prompt.includes('/repo with spaces'));
  for (const repositoryUrl of [undefined, null, '', '   ', 'invalid', 'https://gitlab.com/owner/repo']) {
    const fallback = pullRequestPrompt({ branch: 'draft', repositoryPath: '/repo with spaces', repositoryUrl, base: 'main' });
    assert(fallback.includes('in repository "/repo with spaces", against'));
  }
  assert.match(prompt, /natural, human-readable paragraphs/);
  assert.match(prompt, /code, prose, research, or brainstorming/);
  assert.match(prompt, /intent and meaning/);
  assert.match(prompt, /Omit testing and verification boilerplate for text changes/);
  assert.match(prompt, /Do not describe commit authorship/);
  assert(prompt.endsWith('</a></p>'));
  assert.equal(prompt.split('https://github.com/user-attachments/assets/2d5481b8-54dc-48c6-87e5-b67927d630bd').length, 2);
  assert.equal(prompt.split('https://github.com/pony-factor/kefania').length, 2);
  assert.match(prompt, /align="center"/);
  assert.match(prompt, /alt="This PR description was written automatically\."/);

  let callback, browserAvailable = true;
  const calls = [];
  const uri = { scheme: 'file', fsPath: '/selected repository' };
  const repository = {
    rootUri: uri,
    state: { HEAD: { name: 'draft' }, remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }] },
    async status() {}
  };
  const vscode = {
    Uri: { from: components => components },
    extensions: { getExtension: () => ({ async activate() {
      return { getAPI: () => ({ getRepository(root) { assert.equal(root, uri); return repository; } }) };
    } }) },
    commands: {
      registerCommand(id, handler) { assert.equal(id, 'scmToolkit.openPullRequestChat'); callback = handler; return {}; },
      async getCommands() { return browserAvailable ? ['workbench.action.browser.open'] : []; },
      async executeCommand(id, options) { calls.push({ id, options }); }
    }
  };
  registerPullRequestCommand(vscode, { subscriptions: [] });
  await callback({ rootUri: uri }, { branch: 'draft', remote: 'origin', base: 'main' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'workbench.action.browser.open');
  const url = new URL(calls[0].options.url);
  assert.equal(url.origin, 'https://chatgpt.com');
  assert.match(url.searchParams.get('q'), /"draft"/);
  assert(url.searchParams.get('q').includes('in repository https://github.com/owner/repo, against'));
  assert(!url.searchParams.get('q').includes(uri.fsPath));
  assert.equal(calls[0].options.openToSide, false);
  browserAvailable = false;
  await assert.rejects(callback(uri, { branch: 'draft', base: 'main' }), /Update VS Code/);
  browserAvailable = true;
  repository.state.HEAD.name = 'other';
  await assert.rejects(callback(uri, { branch: 'draft', base: 'main' }), /active branch changed/);
  repository.state.HEAD.name = 'main';
  await assert.rejects(callback(uri, { branch: 'main', base: 'main' }), /other than/);
  assert.equal(calls.length, 1, 'Unavailable or changed selections never open a chat');
  repository.state.HEAD.name = 'draft';
  for (const remote of [undefined, { name: 'origin', fetchUrl: '' }, { name: 'origin', fetchUrl: null }, { name: 'origin', fetchUrl: 'invalid' }]) {
    repository.state.remotes = remote ? [remote] : [];
    await callback(uri, { branch: 'draft', remote: 'origin', base: 'main' });
    const fallback = new URL(calls.at(-1).options.url).searchParams.get('q');
    assert(fallback.includes('in repository "/selected repository", against'));
  }
  assert(require('../efs/package.json').activationEvents.includes('onCommand:scmToolkit.openPullRequestChat'));

  const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
  const callbackSource = source.match(/    const createPullRequest = ([\s\S]*?)\n    };/)[1];
  const sandbox = vm.createContext({
    currentBranch: 'draft', currentRepositoryUri: uri,
    settings: { mcpPullRequest: true, defaultBranch: 'main', remote: 'origin' },
    pending: false, deletingBranch: false, creatingPullRequest: false, creatingPonyBranch: false,
    refreshBranchControls() {}, notifications: { error(error) { throw error; } },
    commands: { async executeCommand(id, root, options) {
      assert.equal(id, 'scmToolkit.openPullRequestChat');
      assert.equal(root, uri);
      assert.equal(options.branch, 'draft');
      assert.equal(options.base, 'main');
    } }
  });
  const click = vm.runInContext(`(${callbackSource}\n    })`, sandbox);
  await click({ stopPropagation() {} });
  assert.equal(sandbox.creatingPullRequest, false);
  console.log('Pull-request browser prompt checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
