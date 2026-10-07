'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let tick, enabled = true, fetches = 0, merges = 0, cleared = false;
const fetchCalls = [];
const main = { rootUri: { scheme: 'file', fsPath: '/repo' }, state: {
  HEAD: { name: 'main', commit: 'base', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 0 },
  indexChanges: [{}], workingTreeChanges: [{}], mergeChanges: []
}, async status() {}, async fetch(options) { fetches++; fetchCalls.push(options); } };
const topic = { rootUri: { scheme: 'file', fsPath: '/topic' }, state: { HEAD: { name: 'topic' } }, async status() {} };
const sandbox = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../efs/branch_actions')), process,
  require(name) {
    if (name === 'node:util') return { promisify(fn) { return (...args) => new Promise((resolve, reject) =>
      fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))); } };
    if (name === 'node:child_process') return { execFile(command, args, options, callback) {
      assert.equal(command, 'git');
      if (args[0] === 'config') {
        const key = args.at(-1);
        const value = key === 'scm-toolkit.auto-pull-clean' ? (enabled ? 'true\n' : 'false\n')
          : key === 'scm-toolkit.default-branch' ? 'main\n'
          : key === 'scm-toolkit.remote' ? 'upstream\n'
          : '';
        callback(null, value, '');
      } else if (args[0] === 'rev-list') {
        assert.deepEqual(Array.from(args), ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/upstream/main']);
        callback(null, '0\t1\n', '');
      } else {
        assert.deepEqual(Array.from(args), ['merge', '--ff-only', 'refs/remotes/upstream/main']);
        merges++;
        callback(null, '', '');
      }
    } };
    return require(name);
  },
  setInterval(callback, delay) { assert.equal(delay, 60000); tick = callback; return { unref() {} }; },
  clearInterval() { cleared = true; }
};
vm.runInNewContext(fs.readFileSync(require.resolve('../efs/branch_actions'), 'utf8'), sandbox);
const context = { subscriptions: [] };
const handlers = {};
const vscode = {
  Uri: { from(value) { return value; } },
  commands: {
    registerCommand(name, callback) {
      handlers[name] = callback;
      return { dispose() { delete handlers[name]; } };
    }
  },
  extensions: {
    getExtension() {
      return {
        async activate() {
          return {
            getAPI() {
              return {
                repositories: [main, topic],
                getRepository(uri) {
                  return uri?.fsPath === main.rootUri.fsPath ? main
                    : uri?.fsPath === topic.rootUri.fsPath ? topic
                    : undefined;
                }
              };
            }
          };
        }
      };
    }
  }
};
(async () => {
  sandbox.module.exports.registerBranchCommands(vscode, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'Main fetches without any renderer or commit input widget');
  assert.equal(fetchCalls[0]?.remote, 'upstream',
    'Default-branch auto-pull uses the configured remote instead of the tracked origin');
  assert.equal(fetchCalls[0]?.ref, 'main');
  assert.equal(merges, 1, 'Nonconflicting local edits do not suppress pulling');

  main.state.HEAD.behind = 1;
  await handlers['scmToolkit.beginCommit'](main.rootUri);
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'Auto-pull does not fetch while a commit is active');
  assert.equal(merges, 1, 'Auto-pull cannot move HEAD while a commit is active');
  await handlers['scmToolkit.endCommit'](main.rootUri);

  tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 2, 'Auto-pull resumes after the commit releases its lease');
  assert.equal(merges, 2, 'The pending fast-forward can run after the commit finishes');
  enabled = false; tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(fetches, 2);
  context.subscriptions.at(-1).dispose(); assert(cleared);
  enabled = true; tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(fetches, 2);
  console.log('Main auto-pull works without a rendered input and respects disable/dispose.');
})().catch(error => { console.error(error); process.exitCode = 1; });
