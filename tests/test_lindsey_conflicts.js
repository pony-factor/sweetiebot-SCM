'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  lindseyScript, safeRelative, inspectPreview, applyPreview, offerConflictRecoveryOptions
} = require('../efs/merge/lindsey_conflicts');

async function run() {
  for (const invalid of ['../secret', '/tmp/abc', '.git/index', 'a//b', 'a\\b', '']) {
    assert.equal(safeRelative(invalid), false);
  }
  assert.equal(safeRelative('src/file.js'), true);

  const calls = [];
  let selection = 'cancel';
  const vscode = {
    window: { showQuickPick: async items => items.find(item => item.id === selection) },
    commands: { executeCommand: async command => { calls.push(command); } }
  };
  const repo = { state: { mergeChanges: [{ resourceUri: { path: '/tmp/a' } }] } };
  const propose = async () => { calls.push('proposal'); };
  for (const [choice, expected] of [
    ['cancel', []], ['review', ['workbench.view.scm']],
    ['manual', ['workbench.view.scm', 'git.openMergeEditor']],
    ['output', ['git.showOutput']], ['lindsey', ['proposal']]
  ]) {
    selection = choice;
    await offerConflictRecoveryOptions(vscode, repo, propose);
    assert.deepEqual(calls.splice(0), expected);
  }

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-lindsey-test-'));
  const root = path.join(folder, 'example'), tmp = path.join(folder, 'preview');
  fs.mkdirSync(root); fs.mkdirSync(tmp);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'topic');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    git('add', 'file.txt'); git('commit', '-m', 'Base');
    const base = git('rev-parse', 'HEAD');
    const original = Buffer.from('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n');
    fs.writeFileSync(path.join(root, 'file.txt'), original);
    const blob = git('rev-parse', base + ':file.txt');
    const index = '100644 ' + blob + ' 1\tfile.txt\n' +
      '100644 ' + blob + ' 2\tfile.txt\n' +
      '100644 ' + blob + ' 3\tfile.txt\n';
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: index });
    const candidate = 'candidate-0.txt';
    fs.writeFileSync(path.join(tmp, candidate), 'merged\n');
    const manifest = {
      version: 1, head: base, branch: 'topic',
      files: [{ path: 'file.txt', candidate,
        originalSha: createHash('sha256').update(original).digest('hex') }]
    };
    const mockRepo = { rootUri: { fsPath: root }, async status() {} };
    assert.equal((await inspectPreview(mockRepo, tmp, manifest)).length, 1);
    assert.equal(await applyPreview(mockRepo, tmp, manifest), 1);
    assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'merged\n');
    assert.match(git('ls-files', '-u', '--', 'file.txt'), /file.txt/);
    await assert.rejects(applyPreview(mockRepo, tmp, manifest), /changed while Lindsey/);
    await assert.rejects(inspectPreview(mockRepo, tmp,
      { ...manifest, files: [{ ...manifest.files[0], path: '../bad' }] }), /invalid/);
    assert.throws(() => lindseyScript(root, [], '/nonexistent/lindsey-sync'), /not available locally/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
