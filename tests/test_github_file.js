'use strict';
const assert = require('node:assert/strict');
const { remoteWebBase, githubFileUrl, openFileOnGitHub, registerOpenFileOnGitHub } = require('./github_file');

async function main() {
  assert.equal(remoteWebBase('git@github.com:owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(remoteWebBase('https://github.com/owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(remoteWebBase('ssh://git@github.com/owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(
    githubFileUrl('git@github.com:owner/repo.git', 'feature/right click', 'docs/a file.md'),
    'https://github.com/owner/repo/blob/feature/right%20click/docs/a%20file.md'
  );

  const opened = [], errors = [], registrations = [];
  const rootUri = { scheme: 'file', fsPath: '/workspace/repo' };
  const fileUri = { scheme: 'file', fsPath: '/workspace/repo/src/main.js' };
  const repository = {
    rootUri,
    state: {
      HEAD: { name: 'topic', upstream: { name: 'topic', remote: 'origin' } },
      remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }]
    }
  };
  const vscode = {
    Uri: { parse: value => ({ value }) },
    env: { openExternal: async uri => opened.push(uri.value) },
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({
      getRepository: uri => uri.fsPath.startsWith(rootUri.fsPath) ? repository : undefined,
      repositories: [repository]
    }) } }) },
    commands: { registerCommand: (id, handler) => { registrations.push({ id, handler }); return { dispose() {} }; } },
    window: { showErrorMessage: message => errors.push(message) }
  };

  const url = await openFileOnGitHub(vscode, { resourceUri: fileUri });
  assert.equal(url, 'https://github.com/owner/repo/blob/topic/src/main.js');
  assert.deepEqual(opened, [url]);

  const context = { subscriptions: [] };
  registerOpenFileOnGitHub(vscode, context);
  assert.equal(registrations.length, 1);
  assert.equal(context.subscriptions.length, 1);
  await registrations[0].handler({ resourceUri: { scheme: 'file', fsPath: '/outside/nope.js' } });
  assert.match(errors.pop(), /not inside a Git repository/);
  console.log('GitHub file opening checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
