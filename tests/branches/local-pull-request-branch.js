'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

let submittedInput, spawnOptions, registerLocalPullRequestCommand;
const originalLoad = Module._load;
Module._load = function(specifier, ...args) {
  if (specifier === 'node:child_process') return {
    ...originalLoad.call(this, specifier, ...args),
    spawn(program, argv, options) {
      spawnOptions = { program, argv, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        on() {},
        end(json) {
          submittedInput = JSON.parse(json);
          queueMicrotask(() => {
            child.stdout.emit('data', JSON.stringify({
              number: 3, url: 'https://github.com/owner/repo/pull/3'
            }));
            child.emit('close', 0);
          });
        }
      };
      return child;
    }
  };
  return originalLoad.call(this, specifier, ...args);
};
try {
  ({ registerLocalPullRequestCommand } = require('../../extension/github/local-pull-request'));
} finally {
  Module._load = originalLoad;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-local-pr-'));
async function run() {
  const repositoryPath = path.join(directory, 'project');
  const runner = path.join(directory, 'kefania', 'src', 'local-pr.js');
  fs.mkdirSync(repositoryPath, { recursive: true });
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.writeFileSync(runner, '// mocked Kefania runner\n');
  const kefania = path.join(directory, 'kefania');
  execFileSync('git', ['-C', kefania, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', kefania, 'remote', 'add', 'origin',
    'https://github.com/pony-factor/kefania-PR.git'], { stdio: 'ignore' });

  let command, openedUrl;
  const warnings = [];
  const rootUri = { scheme: 'file', fsPath: repositoryPath };
  const repository = {
    rootUri,
    state: {
      HEAD: { name: 'draft' },
      remotes: [{ name: 'origin', fetchUrl: 'git@github.com:owner/repo.git' }]
    },
    async status() {
      // Simulate a checkout while VS Code is activating the command.
      this.state.HEAD.name = 'other';
    }
  };
  const vscode = {
    Uri: {
      from: value => value,
      parse: value => ({ value })
    },
    extensions: {
      getExtension(id) {
        if (id === 'openai.chatgpt') return { isActive: true };
        assert.equal(id, 'vscode.git');
        return { async activate() {
          return { getAPI() { return { getRepository() { return repository; } }; } };
        } };
      }
    },
    window: {
      withProgress(_options, action) { return action(); },
      async showInformationMessage() { assert.fail('Publication must not show a redundant success toast'); },
      async showWarningMessage(message) { warnings.push(message); }
    },
    ProgressLocation: { Notification: 1 },
    commands: {
      registerCommand(id, handler) {
        assert.equal(id, 'sweetiebot.createLocalPullRequest');
        command = handler;
        return { dispose() {} };
      },
      async getCommands() { return ['sweetiebot.readCodexConversation']; },
      async executeCommand(id, uri) {
        if (id === 'sweetiebot.readCodexConversation') {
          throw new Error('The active Codex chat changed during capture.');
        }
        assert.equal(id, 'vscode.open');
        openedUrl = uri.value;
      }
    }
  };
  registerLocalPullRequestCommand(vscode, { subscriptions: [] }, { pendingPRCommits: async () => undefined,
    resolveForkPullRequestTarget: async (_vscode, url, base) => ({
      repository: 'owner/repo', repositoryUrl: url, base
    }) });
  const result = await command({ rootUri }, {
    branch: 'draft', base: 'main', remote: 'origin',
    source: {
      kind: 'chatgpt',
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    }
  });

  assert.equal(result.number, 3);
  assert.equal(openedUrl, result.url);
  assert.equal(spawnOptions.options.cwd, repositoryPath);
  assert.equal(spawnOptions.argv[0], runner);
  assert.equal(submittedInput.repository, 'owner/repo');
  assert.equal(submittedInput.head, 'draft', 'Local fallback publishes the selected branch');
  assert.equal(submittedInput.base, 'main');
  assert.equal(repository.state.HEAD.name, 'other', 'Do not switch the current checkout');

  const fallbackResult = await command({ rootUri }, { branch: 'draft', base: 'main', remote: 'origin' });
  assert.equal(fallbackResult.number, 3, 'Local PR creation continues after Codex capture fails');
  assert.equal(submittedInput.source, undefined, 'Do not attach a source from another Codex chat');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not copy the originating Codex chat/);
  assert.match(warnings[0], /Continuing without its transcript and source links/);

  await assert.rejects(command({ rootUri }, {
    branch: 'main', base: 'main', remote: 'origin'
  }), /other than/);
  console.log('Local Kefania branch-switch regression checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
