'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function run() {
  let nextSubject = '🐜 Fix commit title';
  let expectedInput = '';
  let choice = 'Apply correction';
  let spawnCount = 0;
  const children = [];
  const commands = new Map();
  const notices = [];

  const spawn = (executable, args, options) => {
    spawnCount++;
    assert.equal(executable, '/resolved/python3');
    assert.deepEqual(Array.from(args), ['/extension/ai_commit.py', '--spellcheck-subject']);
    assert.equal(options.cwd, '/repo');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.kill = () => { child.killed = true; };
    child.stdin = new EventEmitter();
    child.stdin.end = value => {
      assert.equal(value, expectedInput);
      child.stdout.emit('data', JSON.stringify({ subject: nextSubject }));
      child.emit('close', 0);
    };
    children.push(child);
    return child;
  };

  const sandbox = vm.createContext({
    module: { exports: {} },
    process,
    setTimeout: () => 1,
    clearTimeout: () => {},
    require(name) {
      if (name === 'child_process') return { spawn };
      if (name === './python_runtime') {
        return {
          resolvePythonExecutable: () => '/resolved/python3',
          pythonLaunchError: error => error
        };
      }
      throw new Error('Unexpected require: ' + name);
    }
  });
  vm.runInContext(
    fs.readFileSync(require.resolve('../efs/spellcheck_preview.js'), 'utf8'),
    sandbox
  );

  const vscode = {
    Uri: {
      from: uri => uri,
      joinPath: (_, file) => ({ fsPath: '/extension/' + file })
    },
    commands: {
      registerCommand(id, callback) {
        commands.set(id, callback);
        return {};
      }
    },
    window: {
      async showInformationMessage(...args) {
        notices.push(args);
        return args.includes('Apply correction') ? choice : undefined;
      }
    }
  };
  sandbox.module.exports.registerSpellcheckPreviewCommand(vscode, {
    extensionUri: {},
    extensionPath: '/extension',
    subscriptions: []
  });
  const preview = commands.get('sweetiebot.previewCommitSpellcheck');
  const uri = { scheme: 'file', fsPath: '/repo' };

  const original = '🐜 Fxi commit titel\n\nBody stays exact.';
  expectedInput = '🐜 Fxi commit titel';
  choice = 'Apply correction';
  assert.equal(
    await preview(uri, original),
    '🐜 Fix commit title\n\nBody stays exact.'
  );
  assert.match(notices.at(-1)[1].detail, /Original:/);
  assert.match(notices.at(-1)[1].detail, /Suggested:/);

  choice = 'Keep original';
  assert.equal(await preview(uri, original), original);

  nextSubject = expectedInput;
  assert.equal(await preview(uri, original), original);
  assert.match(notices.at(-1)[0], /no spelling changes/i);

  const beforeCodex = spawnCount;
  const codex = '🐜 Fxi commit titel\n\nCo-authored-by: Codex <noreply@openai.com>';
  assert.equal(await preview(uri, codex), codex);
  assert.equal(spawnCount, beforeCodex);
  assert.match(notices.at(-1)[0], /Codex-attributed/);

  const codexWeb = '🐜 Fxi commit titel\n\nCo-authored-by: Codex Web <noreply@openai.com>';
  assert.equal(await preview(uri, codexWeb), codexWeb);
  assert.equal(spawnCount, beforeCodex);
  assert.match(notices.at(-1)[0], /Codex-attributed/);

  assert.equal(sandbox.module.exports.hasCodexCoauthor(codex), true);
  assert.equal(sandbox.module.exports.hasCodexCoauthor(codexWeb), true);
  assert.equal(
    sandbox.module.exports.hasCodexCoauthor('🐜 Fxi commit titel\n\nCo-authored-by: Person <person@example.com>'),
    false
  );

  console.log('Commit spellcheck preview checks passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
