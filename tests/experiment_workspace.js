'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openExperimentWorkspace, privateParent } = require('../extension/branches/experiment_workspace');

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function editor(root) {
  const calls = [], warnings = [], errors = [];
  return {
    calls, warnings, errors,
    workspace: { workspaceFolders: [{ name: 'Original', uri: { scheme: 'file', fsPath: root } }] },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    commands: { async executeCommand(id, ...args) {
      calls.push([id, ...args]);
      if (id === 'sweetiebot.codex.sendExperimentDirection') return true;
    } },
    window: {
      showWarningMessage(message) { warnings.push(message); },
      showErrorMessage(message) { errors.push(message); }
    }
  };
}

(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-experiment-test-'));
  try {
    const original = path.join(tmp, 'original');
    const copies = path.join(tmp, 'Sweetiebot');
    await fs.mkdir(original);
    git('init', '-b', 'main', original);
    git('-C', original, 'config', 'user.name', 'Sweetiebot Test');
    git('-C', original, 'config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(original, 'tracked.txt'), 'committed\n');
    git('-C', original, 'add', 'tracked.txt');
    git('-C', original, 'commit', '-m', 'Initial');
    git('-C', original, 'switch', '-c', 'topic');
    await fs.writeFile(path.join(original, 'tracked.txt'), 'staged\n');
    git('-C', original, 'add', 'tracked.txt');
    await fs.writeFile(path.join(original, 'tracked.txt'), 'staged\nunstaged\n');
    await fs.writeFile(path.join(original, 'pending.bin'), Buffer.from([0, 128, 255, 10]));

    const before = {
      work: git('-C', original, 'diff', '--binary', 'HEAD'),
      index: git('-C', original, 'diff', '--cached', '--binary', 'HEAD'),
      status: git('-C', original, 'status', '--short')
    };
    const vscode = editor(original);
    const first = await openExperimentWorkspace(vscode, { baseDirectory: copies });
    assert.equal(first.branch, 'topic');
    assert.equal(first.directionSent, true);
    assert.equal(vscode.calls[0][0], 'vscode.openFolder');
    assert.equal(vscode.calls[0][2].forceNewWindow, true);
    assert.equal(vscode.calls[1][0], 'sweetiebot.codex.sendExperimentDirection');
    assert.deepEqual(vscode.calls[1][1], {
      source: await fs.realpath(original), destination: first.destination, branch: 'topic'
    });
    assert(first.directory.startsWith(await fs.realpath(copies) + path.sep));
    assert.equal((await fs.stat(copies)).mode & 0o077, 0, 'Trusted parent stays private');
    assert.equal(git('-C', first.destination, 'branch', '--show-current'), 'topic');
    assert.equal(git('-C', first.destination, 'rev-parse', 'HEAD'), git('-C', original, 'rev-parse', 'HEAD'));
    assert.equal(git('-C', first.destination, 'diff', '--binary', 'HEAD'), before.work);
    assert.equal(git('-C', first.destination, 'diff', '--cached', '--binary', 'HEAD'), before.index);
    assert.equal(git('-C', first.destination, 'status', '--short'), before.status);
    assert.deepEqual(await fs.readFile(path.join(first.destination, 'pending.bin')), Buffer.from([0, 128, 255, 10]));
    assert.equal(git('-C', first.destination, 'remote'), '', 'No accidental push into the source checkout');
    assert.equal(git('-C', first.destination, 'show-ref', '--verify', 'refs/heads/main').length > 0, true,
      'Other local branches survive removal of temporary clone origin');
    git('-C', first.destination, 'reset', '--hard', 'HEAD');
    assert.equal(git('-C', original, 'status', '--short'), before.status,
      'Resetting the experiment never changes the source');

    const second = await openExperimentWorkspace(editor(original), { baseDirectory: copies });
    assert.notEqual(second.directory, first.directory);

    const bare = path.join(tmp, 'remote.git');
    git('init', '--bare', bare);
    git('-C', original, 'remote', 'add', 'origin', bare);
    const hosted = await openExperimentWorkspace(editor(original), { baseDirectory: copies });
    assert.equal(git('-C', hosted.destination, 'remote', 'get-url', 'origin'), bare);

    await fs.symlink(path.join(original, 'tracked.txt'), path.join(original, 'unsafe-link'));
    await assert.rejects(openExperimentWorkspace(editor(original), { baseDirectory: copies }), /Untracked symbolic links/);
    await fs.unlink(path.join(original, 'unsafe-link'));

    const maliciousParent = path.join(tmp, 'redirect');
    await fs.symlink(copies, maliciousParent);
    await assert.rejects(privateParent(maliciousParent), /private directory/);

    const invalid = editor(original);
    invalid.workspace.workspaceFolders.push({ uri: { scheme: 'file', fsPath: original } });
    await assert.rejects(openExperimentWorkspace(invalid, { baseDirectory: copies }), /exactly one/);

    console.log('Experimental clone, branch, remote, snapshot, safe reset and Codex direction passed.');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
