'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { openIndependentWorkspace } = require('../efs/new_workspace');
const { routeBranch, originalRepository, reconnectManagedMain } = require('../efs/shared_main');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const editor = root => ({
  workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: root }, name: 'Repo' }] },
  Uri: { file: fsPath => ({ fsPath }) },
  calls: [], commands: { async executeCommand(...args) { this.calls.push(args); }, calls: [] }
});
async function openedRoot(result) {
  return JSON.parse(await fs.readFile(result.target, 'utf8')).folders[0].path;
}

(async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shared-main-test-')));
  const githubDirectory = path.join(temporary, 'GitHub');
  const baseDirectory = path.join(temporary, 'Workspaces');
  const root = path.join(githubDirectory, 'owner', 'repo');
  const options = { githubDirectory, baseDirectory };
  try {
    await fs.mkdir(root, { recursive: true });
    git('init', '-b', 'main', root);
    git('-C', root, 'config', 'user.name', 'Test');
    git('-C', root, 'config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(root, 'file.txt'), 'committed main\n');
    git('-C', root, 'add', 'file.txt');
    git('-C', root, 'commit', '-m', 'Fixture');
    git('-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');

    const first = await openIndependentWorkspace(editor(root), options);
    const second = await openIndependentWorkspace(editor(root), options);
    assert.notEqual(first.target, second.target, 'Window identities remain independent');
    assert.equal(await openedRoot(first), root);
    assert.equal(await openedRoot(second), root);
    await fs.writeFile(path.join(root, 'file.txt'), 'pending shared main\n');
    assert.equal(await fs.readFile(path.join(await openedRoot(second), 'file.txt'), 'utf8'), 'pending shared main\n');

    const topicEditor = editor(root);
    assert.equal(await routeBranch(topicEditor, { rootUri: { fsPath: root } },
      { ...options, branch: 'topic', create: true, start: 'main' }), true);
    assert.deepEqual(topicEditor.commands.calls.at(-1)[2], { forceNewWindow: true },
      'New topics open in a separate window instead of reloading the main workspace');
    assert.equal(topicEditor.workspace.workspaceFolders[0].uri.fsPath, root,
      'The originating main workspace and Codex session remain untouched');
    const topicWorkspace = topicEditor.commands.calls.at(-1)[1].fsPath;
    const topic = await openedRoot({ target: topicWorkspace });
    assert.equal(git('-C', topic, 'branch', '--show-current'), 'topic');
    assert.equal(git('-C', root, 'branch', '--show-current'), 'main', 'Never switch the shared main folder');
    assert.equal(await originalRepository(topic, options), root);
    assert.equal(await fs.readFile(path.join(topic, 'file.txt'), 'utf8'), 'committed main\n');
    await fs.writeFile(path.join(topic, 'file.txt'), 'private topic edit\n');
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'pending shared main\n');
    const returning = editor(topic);
    assert.equal(await routeBranch(returning, { rootUri: { fsPath: topic } }, { ...options, branch: 'main' }), true);
    assert.equal(await openedRoot({ target: returning.commands.calls.at(-1)[1].fsPath }), root);
    assert.equal(await fs.readFile(path.join(topic, 'file.txt'), 'utf8'), 'private topic edit\n', 'Returning home preserves private topic edits');
    const reopening = editor(root);
    await routeBranch(reopening, { rootUri: { fsPath: root } }, { ...options, branch: 'topic' });
    assert.equal(await openedRoot({ target: reopening.commands.calls.at(-1)[1].fsPath }), topic);

    const legacy = path.join(baseDirectory, 'legacy', 'repo');
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    git('clone', '--local', root, legacy);
    git('-C', legacy, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
    assert.equal(await reconnectManagedMain(editor(legacy), options), true, 'Clean legacy main reconnects to the original');
    await fs.writeFile(path.join(legacy, 'file.txt'), 'separate old edits\n');
    await assert.rejects(reconnectManagedMain(editor(legacy), options), /separate pending edits/);
    assert.equal(await fs.readFile(path.join(legacy, 'file.txt'), 'utf8'), 'separate old edits\n');
    assert.equal(await reconnectManagedMain(editor(topic), options), false, 'Topic windows stay disconnected');
    git('-C', root, 'switch', '-c', 'external-topic');
    await assert.rejects(openIndependentWorkspace(editor(legacy), options), /must be on main/);
    console.log('Shared main windows, isolated topics, reconnection and legacy preservation passed.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
