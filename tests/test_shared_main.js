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
    assert.equal(path.dirname(first.directory), path.join(baseDirectory, 'repo'));
    assert.match(path.basename(first.directory), /^[0-9a-f-]{36}$/);
    assert.equal(await openedRoot(first), root);
    assert.equal(await openedRoot(second), root);
    await fs.writeFile(path.join(root, 'file.txt'), 'pending shared main\n');
    assert.equal(await fs.readFile(path.join(await openedRoot(second), 'file.txt'), 'utf8'), 'pending shared main\n');

    const topicEditor = editor(root);
    assert.equal(await routeBranch(topicEditor, { rootUri: { fsPath: root } },
      { ...options, branch: 'topic', create: true, start: 'main' }), true);
    assert.deepEqual(topicEditor.commands.calls.at(-1)[2], { forceReuseWindow: true },
      'The selected branch replaces this window so the same Codex chat can follow');
    assert.equal(topicEditor.workspace.workspaceFolders[0].uri.fsPath, root,
      'The originating main workspace and Codex session remain untouched');
    const topicWorkspace = topicEditor.commands.calls.at(-1)[1].fsPath;
    const topic = await openedRoot({ target: topicWorkspace });
    assert.equal(path.dirname(path.dirname(topic)), path.join(baseDirectory, 'repo'));
    assert.match(path.basename(path.dirname(topic)), /^[0-9a-f-]{36}$/);
    assert.equal(path.dirname(path.dirname(topicWorkspace)), path.join(baseDirectory, 'repo'));
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

    await fs.writeFile(path.join(root, 'draft.txt'), 'untracked task work\n');
    git('-C', root, 'add', 'file.txt');
    const moving = editor(root);
    moving.extensions = { getExtension: () => ({ async activate() {} }) };
    moving.commands.getCommands = async () => ['sweetiebot.codex.prepareWorkspaceHandoff'];
    const ordinaryExecute = moving.commands.executeCommand;
    moving.commands.executeCommand = async function (id, ...args) {
      if (id === 'sweetiebot.codex.prepareWorkspaceHandoff') return { threadId: 'fixture', relative: '', wasActive: true };
      return ordinaryExecute.call(this, id, ...args);
    };
    await routeBranch(moving, { rootUri: { fsPath: root } }, { ...options, branch: 'moving-task', create: true });
    const moved = await openedRoot({ target: moving.commands.calls.at(-1)[1].fsPath });
    assert.equal(await fs.readFile(path.join(moved, 'file.txt'), 'utf8'), 'pending shared main\n');
    assert.equal(await fs.readFile(path.join(moved, 'draft.txt'), 'utf8'), 'untracked task work\n');
    assert.equal(git('-C', moved, 'diff', '--cached'), '', 'Copied task work is never staged');
    assert.equal(git('-C', root, 'status', '--porcelain'), '', 'Transferred changes leave main clean');
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'committed main\n');
    assert.equal(await fs.stat(path.join(root, 'draft.txt')).then(() => true, () => false), false);

    assert(moving.commands.calls.some(call => call[0] === 'sweetiebot.codexHandoff.save'));

    // Saved workspaces switch folders without reopening the workbench.
    moving.workspace.workspaceFile = { scheme: 'file', fsPath: first.target };
    moving.commands.calls.length = 0;
    let folderUpdate;
    moving.workspace.updateWorkspaceFolders = (...args) => {
      folderUpdate = args;
      assert(moving.commands.calls.some(call => call[0] === 'sweetiebot.codexHandoff.save'),
        'Save the same-chat handoff before an extension-host restart');
      return true;
    };
    await routeBranch(moving, { rootUri: { fsPath: root } }, { ...options, branch: 'topic' });
    assert.deepEqual(folderUpdate, [0, 1, { uri: { fsPath: topic }, name: 'Repo' }]);
    assert(!moving.commands.calls.some(call => call[0] === 'vscode.openFolder'),
      'An existing saved workspace must not reopen the window');
    const saved = moving.commands.calls.find(call => call[0] === 'sweetiebot.codexHandoff.save')[1];
    assert.equal(saved.workspace, first.target, 'Keep the existing workspace identity');
    assert.equal(saved.plan.destination, topic);

    await fs.writeFile(path.join(root, 'draft.txt'), 'untracked task work\n');
    moving.commands.calls.length = 0;
    await routeBranch(moving, { rootUri: { fsPath: root } },
      { ...options, branch: 'smooth-task', create: true });
    const smooth = folderUpdate[2].uri.fsPath;
    assert.equal(git('-C', smooth, 'branch', '--show-current'), 'smooth-task');
    assert.equal(git('-C', root, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(smooth, 'draft.txt'), 'utf8'), 'untracked task work\n');
    assert(!moving.commands.calls.some(call => call[0] === 'vscode.openFolder'),
      'Creating a branch also keeps the existing workbench');

    // A new branch from an existing topic must also use a new worktree.
    moving.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: moved }, name: 'Repo' }];
    const topicIndex = git('-C', moved, 'diff', '--cached');
    moving.commands.calls.length = 0;
    await routeBranch(moving, { rootUri: { fsPath: moved } },
      { ...options, branch: 'from-topic', create: true, start: 'refs/heads/main' });
    const fromTopic = folderUpdate[2].uri.fsPath;
    assert.equal(git('-C', fromTopic, 'branch', '--show-current'), 'from-topic');
    assert.equal(git('-C', fromTopic, 'rev-parse', 'HEAD'), git('-C', root, 'rev-parse', 'main'));
    assert.equal(git('-C', moved, 'branch', '--show-current'), 'moving-task');
    assert.equal(git('-C', root, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(fromTopic, 'draft.txt'), 'utf8'), 'untracked task work\n');
    assert.equal(git('-C', moved, 'diff', '--cached'), topicIndex);
    assert.equal(git('-C', moved, 'status', '--porcelain'), '', 'Topic-to-topic handoff also moves pending edits');

    assert(!moving.commands.calls.some(call => call[0] === 'vscode.openFolder'));
    const forkScript = path.join(temporary, 'fork_fixture.py');
    await fs.writeFile(forkScript, [
      'import subprocess, sys',
      'head = subprocess.check_output(["git", "symbolic-ref", "HEAD"], text=True).strip()',
      'assert head == sys.argv[4], "Expected the job owner HEAD under the helper lock"',
      'subprocess.run(["git", "worktree", "add", "-b", sys.argv[3], "--", sys.argv[5], sys.argv[2]], check=True)'
    ].join('\n'));
    await routeBranch(moving, { rootUri: { fsPath: moved } }, {
      ...options, branch: 'pending-from-topic', create: true, forkScript,
      source: 'refs/heads/main', expectedHead: 'refs/heads/moving-task'
    });
    assert.equal(git('-C', folderUpdate[2].uri.fsPath, 'branch', '--show-current'), 'pending-from-topic');
    await assert.rejects(routeBranch(moving, { rootUri: { fsPath: moved } }, {
      ...options, branch: 'stale-from-topic', create: true, forkScript,
      source: 'refs/heads/main', expectedHead: 'refs/heads/stale'
    }), /active branch changed/);
    assert.equal(git('-C', root, 'branch', '--show-current'), 'main');
    moving.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root }, name: 'Repo' }];

    moving.commands.calls.length = 0;
    moving.workspace.updateWorkspaceFolders = () => false;
    await assert.rejects(routeBranch(moving, { rootUri: { fsPath: root } },
      { ...options, branch: 'topic' }), /could not update/);
    assert(moving.commands.calls.some(call => call[0] === 'sweetiebot.codexHandoff.clear'));
    assert(moving.commands.calls.some(call => call[0] === 'sweetiebot.codex.resumeWorkspaceHandoff' && call[1].destination === root),
      'A rejected folder update resumes the chat in its original checkout');

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
    await fs.writeFile(path.join(root, 'file.txt'), 'original topic edits\n');
    git('-C', root, 'add', 'file.txt');
    await fs.writeFile(path.join(root, 'file.txt'), 'additional unstaged topic edits\n');
    const originalStatus = git('-C', root, 'status', '--porcelain');
    const originalIndex = git('-C', root, 'diff', '--cached');
    const fallbackEditor = editor(root);
    const fallback = await openIndependentWorkspace(fallbackEditor, options);
    assert.equal(git('-C', fallback.target, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(fallback.target, 'file.txt'), 'utf8'), 'committed main\n');
    assert.deepEqual(fallbackEditor.commands.calls.at(-1)[2], { forceNewWindow: true });
    assert.equal(git('-C', root, 'branch', '--show-current'), 'external-topic');
    assert.equal(git('-C', root, 'status', '--porcelain'), originalStatus);
    assert.equal(git('-C', root, 'diff', '--cached'), originalIndex);
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'additional unstaged topic edits\n');
    assert.equal(await reconnectManagedMain(editor(fallback.target), options), false,
      'New main clone remains usable while the original is on a topic');
    const legacyFallback = await openIndependentWorkspace(editor(legacy), options);
    assert.equal(git('-C', legacyFallback.target, 'branch', '--show-current'), 'main');
    const originalTopicEditor = editor(root);
    assert.equal(await routeBranch(originalTopicEditor, { rootUri: { fsPath: root } }, {
      ...options, branch: 'new-from-original-topic', create: true, start: 'refs/heads/main'
    }), true, 'New Branch works when the original checkout is still on a topic');
    const newFromOriginal = await openedRoot({ target: originalTopicEditor.commands.calls.at(-1)[1].fsPath });
    assert.equal(git('-C', newFromOriginal, 'branch', '--show-current'), 'new-from-original-topic');
    assert.equal(git('-C', newFromOriginal, 'rev-parse', 'HEAD'), git('-C', root, 'rev-parse', 'main'));
    assert.equal(git('-C', root, 'branch', '--show-current'), 'external-topic');
    assert.equal(git('-C', root, 'status', '--porcelain'), originalStatus);
    assert.equal(git('-C', root, 'diff', '--cached'), originalIndex);
    console.log('Shared main windows, isolated topics, reconnection and legacy preservation passed.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
