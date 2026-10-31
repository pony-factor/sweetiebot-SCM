'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { openIndependentWorkspace } = require('../extension/branches/new_workspace');
const { routeBranch, originalRepository, reconnectManagedMain } = require('../extension/branches/shared_main');
const { registerManagedWindowActivity, stopManagedWindowActivity } =
  require('../extension/branches/workspace_activity');

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
  const options = { githubDirectory, baseDirectory, alive: () => true };
  try {
    await fs.mkdir(root, { recursive: true });
    git('init', '-b', 'main', root);
    git('-C', root, 'config', 'user.name', 'Test');
    git('-C', root, 'config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(root, 'file.txt'), 'committed main\n');
    await fs.writeFile(path.join(root, 'mixed.txt'), 'committed mixed\n');
    git('-C', root, 'add', 'file.txt', 'mixed.txt');
    git('-C', root, 'commit', '-m', 'Fixture');
    git('-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');

    const first = await openIndependentWorkspace(editor(root), options);
    const second = await openIndependentWorkspace(editor(root), options);
    assert.notEqual(first.target, second.target, 'Window identities remain independent');
    assert.equal(path.dirname(first.directory), path.join(baseDirectory, 'repo'));
    assert.match(path.basename(first.directory), /^main-[a-z]+$/);
    assert.equal(path.basename(first.target), path.basename(first.directory) + '.code-workspace');
    assert.equal(await openedRoot(first), root);
    assert.equal(await openedRoot(second), root);
    await fs.writeFile(path.join(root, 'file.txt'), 'pending shared main\n');
    assert.equal(await fs.readFile(path.join(await openedRoot(second), 'file.txt'), 'utf8'), 'pending shared main\n');
    await fs.writeFile(path.join(root, 'staged.txt'), 'staged addition\n');
    await fs.writeFile(path.join(root, 'mixed.txt'), 'staged mixed\n');
    git('-C', root, 'add', 'staged.txt', 'mixed.txt');
    await fs.appendFile(path.join(root, 'mixed.txt'), 'unstaged mixed\n');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked addition\n');
    const initialStatus = git('-C', root, 'status', '--porcelain');
    const initialIndex = git('-C', root, 'diff', '--cached', '--binary');
    const initialWorktree = git('-C', root, 'diff', '--binary');

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
    assert.match(path.basename(path.dirname(topic)), /^topic-(?:\d+-)?[a-z]+$/);
    assert.equal(path.dirname(path.dirname(topicWorkspace)), path.join(baseDirectory, 'repo'));
    assert.equal(path.basename(topicWorkspace), path.basename(path.dirname(topicWorkspace)) + '.code-workspace');
    assert.equal(git('-C', topic, 'branch', '--show-current'), 'topic');
    assert.equal(git('-C', root, 'branch', '--show-current'), 'main', 'Never switch the shared main folder');
    assert.equal(await originalRepository(topic, options), root);
    assert.equal(await fs.readFile(path.join(topic, 'file.txt'), 'utf8'), 'pending shared main\n');
    assert.equal(git('-C', topic, 'status', '--porcelain'), initialStatus,
      'New Branch transfers staged, unstaged, partially staged and untracked changes without Codex');
    assert.equal(git('-C', topic, 'diff', '--cached', '--binary'), initialIndex);
    assert.equal(git('-C', topic, 'diff', '--binary'), initialWorktree);
    assert.equal(git('-C', root, 'status', '--porcelain'), '', 'Verified transfer cleans main');
    const recovery = path.join(path.dirname(topic), '.sweetiebot-handoff-backup');
    assert.equal((await fs.readFile(path.join(recovery, 'index.patch'), 'utf8')).trim(), initialIndex);
    assert.equal(await fs.readFile(path.join(recovery, 'files/untracked.txt'), 'utf8'), 'untracked addition\n');
    await fs.writeFile(path.join(topic, 'file.txt'), 'private topic edit\n');
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'committed main\n');
    const returning = editor(topic);
    assert.equal(await routeBranch(returning, { rootUri: { fsPath: topic } }, { ...options, branch: 'main' }), true);
    assert.equal(await openedRoot({ target: returning.commands.calls.at(-1)[1].fsPath }), root);
    assert.equal(await fs.readFile(path.join(topic, 'file.txt'), 'utf8'), 'private topic edit\n', 'Returning home preserves private topic edits');
    const reopening = editor(root);
    await routeBranch(reopening, { rootUri: { fsPath: root } }, { ...options, branch: 'topic' });
    assert.equal(await openedRoot({ target: reopening.commands.calls.at(-1)[1].fsPath }), topic);

    // End-to-end integration using the real session publisher rather than a
    // handcrafted marker: routing to an occupied branch focuses its existing
    // live workspace and only then closes the initiating window.
    const ownerWindow = editor(topic);
    ownerWindow.workspace.workspaceFile = { scheme: 'file', fsPath: topicWorkspace };
    const activityContext = { subscriptions: [] };
    await registerManagedWindowActivity(ownerWindow, activityContext, {
      groups: [path.dirname(topic)], uuid: 'ci-live-window', pid: process.pid
    });
    try {
      const sessionFile = path.join(path.dirname(topic),
        '.sweetiebot-session-' + process.pid + '-ci-live-window.json');
      const published = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
      assert.deepEqual(published.roots, [topic]);
      assert.equal(published.workspaceFile, topicWorkspace);
      const switchingWindow = editor(root);
      assert.equal(await routeBranch(switchingWindow, { rootUri: { fsPath: root } },
        { ...options, sourcePid: process.pid + 1, branch: 'topic' }), true);
      assert.deepEqual(switchingWindow.commands.calls.map(call => call[0]),
        ['vscode.openFolder', 'workbench.action.closeWindow'],
        'Live owner receives focus before the initiating window closes');
      assert.equal(switchingWindow.commands.calls[0][1].fsPath, topicWorkspace);
      assert.deepEqual(switchingWindow.commands.calls[0][2], { forceNewWindow: true });
      assert.equal(switchingWindow.workspace.workspaceFolders[0].uri.fsPath, root,
        'Do not mutate source workspace folders while a destination window owns the branch');
      assert.equal(git('-C', root, 'branch', '--show-current'), 'main');
      assert.equal(git('-C', topic, 'branch', '--show-current'), 'topic');
    } finally {
      await stopManagedWindowActivity();
    }
    assert.equal(await fs.stat(path.join(path.dirname(topic),
      '.sweetiebot-session-' + process.pid + '-ci-live-window.json')).then(
      () => true, () => false), false, 'Stopping the owner removes its live-session marker');

    // A failed destination apply must retain the source and a recovery copy.
    await fs.writeFile(path.join(root, 'file.txt'), 'preserve on failed transfer\n');
    git('-C', root, 'add', 'file.txt');
    const failedStatus = git('-C', root, 'status', '--porcelain');
    const failedIndex = git('-C', root, 'diff', '--cached');
    let failedDestination;
    await assert.rejects(routeBranch(editor(root), { rootUri: { fsPath: root } }, {
      ...options, branch: 'failed-transfer', create: true,
      run: async args => {
        const result = git(...args);
        if (args.includes('worktree') && args.includes('add')) {
          failedDestination = args[args.indexOf('--') + 1];
          await fs.writeFile(path.join(failedDestination, 'file.txt'), 'conflicting destination\n');
        }
        return result;
      }
    }), /recovery copy is saved/);
    assert.equal(git('-C', root, 'status', '--porcelain'), failedStatus);
    assert.equal(git('-C', root, 'diff', '--cached'), failedIndex);
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'preserve on failed transfer\n');
    assert.equal((await fs.readFile(path.join(path.dirname(failedDestination),
      '.sweetiebot-handoff-backup/index.patch'), 'utf8')).trim(), failedIndex);
    git('-C', root, 'restore', '--source=HEAD', '--staged', '--worktree', 'file.txt');

    await fs.writeFile(path.join(root, 'draft.txt'), 'untracked task work\n');
    await fs.writeFile(path.join(root, 'file.txt'), 'pending shared main\n');
    git('-C', root, 'add', 'file.txt');
    const movingIndex = git('-C', root, 'diff', '--cached');
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
    assert.equal(git('-C', moved, 'diff', '--cached'), movingIndex, 'Keep the user\'s existing staging');
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
    // A live topic owner should be focused, preserving its editors and chat.
    const topicSession = path.join(path.dirname(topic), '.sweetiebot-session-2345-test.json');
    await fs.writeFile(topicSession,
      JSON.stringify({ pid: process.pid + 1, roots: [topic], workspaceFile: topicWorkspace }));
    await routeBranch(moving, { rootUri: { fsPath: root } }, { ...options, branch: 'topic' });
    assert.deepEqual(moving.commands.calls.map(call => call[0]),
      ['vscode.openFolder', 'workbench.action.closeWindow'],
      'Focus the live worktree owner before closing this window');
    assert.equal(moving.commands.calls[0][1].fsPath, topicWorkspace);
    assert.deepEqual(moving.commands.calls[0][2], { forceNewWindow: true });
    assert.equal(folderUpdate, undefined, 'Do not repoint a window while its target is already open');

    // A failed focus must not close the source window or change its workspace.
    const failedFocus = editor(root);
    failedFocus.commands.executeCommand = async function (...args) {
      this.calls.push(args);
      if (args[0] === 'vscode.openFolder') throw new Error('Cannot focus existing window');
    };
    await assert.rejects(routeBranch(failedFocus, { rootUri: { fsPath: root } },
      { ...options, branch: 'topic' }), /Cannot focus existing window/);
    assert.deepEqual(failedFocus.commands.calls.map(call => call[0]), ['vscode.openFolder']);
    assert.equal(folderUpdate, undefined);

    // When the owner is gone, keep this window and its Codex handoff.
    const expired = new Date(Date.now() - 200000);
    await fs.utimes(topicSession, expired, expired);
    moving.commands.calls.length = 0;
    await routeBranch(moving, { rootUri: { fsPath: root } }, { ...options, branch: 'topic' });
    assert.deepEqual(folderUpdate, [0, 1, { uri: { fsPath: topic }, name: 'Repo' }]);
    assert(!moving.commands.calls.some(call => call[0] === 'vscode.openFolder'),
      'A stale owner must not prevent reopening an existing worktree');
    assert(!moving.commands.calls.some(call => call[0] === 'workbench.action.closeWindow'),
      'Keep the initiating window when no live topic window exists');
    const saved = moving.commands.calls.find(call => call[0] === 'sweetiebot.codexHandoff.save')[1];
    assert.equal(saved.workspace, first.target, 'Keep the existing workspace identity');
    assert.equal(saved.plan.destination, topic);

    // Returning to main keeps the same workspace and chat, too.
    moving.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: topic }, name: 'Repo' }];
    moving.commands.calls.length = 0;
    assert.equal(await routeBranch(moving, { rootUri: { fsPath: topic } },
      { ...options, branch: 'main', forceNewWindow: true }), true);
    assert.deepEqual(folderUpdate, [0, 1, { uri: { fsPath: root }, name: 'Repo' }]);
    assert(!moving.commands.calls.some(call => call[0] === 'vscode.openFolder'),
      'Returning to main must keep the existing workbench');
    const homeHandoff = moving.commands.calls.find(call => call[0] === 'sweetiebot.codexHandoff.save')[1];
    assert.equal(homeHandoff.workspace, first.target);
    assert.equal(homeHandoff.plan.destination, root);
    assert.equal(await fs.readFile(path.join(topic, 'file.txt'), 'utf8'), 'private topic edit\n');
    assert.equal(git('-C', topic, 'branch', '--show-current'), 'topic');

    // Returning home focuses its existing window rather than taking over main.
    const mainSession = path.join(first.directory, '.sweetiebot-session-2345-test.json');
    await fs.writeFile(mainSession,
      JSON.stringify({ pid: process.pid + 1, roots: [root], workspaceFile: first.target }));
    const mainSwitcher = editor(topic);
    assert.equal(await routeBranch(mainSwitcher, { rootUri: { fsPath: topic } },
      { ...options, branch: 'main' }), true);
    assert.deepEqual(mainSwitcher.commands.calls.map(call => call[0]),
      ['vscode.openFolder', 'workbench.action.closeWindow']);
    assert.equal(mainSwitcher.commands.calls[0][1].fsPath, first.target);
    assert.deepEqual(mainSwitcher.commands.calls[0][2], { forceNewWindow: true });
    await fs.rm(mainSession);
    moving.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root }, name: 'Repo' }];

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
    // A topic window must route to another occupied topic worktree, not fall
    // through to git checkout (which rejects branches held by a worktree).
    const topicSwitcher = editor(topic);
    assert.equal(await routeBranch(topicSwitcher, { rootUri: { fsPath: topic } },
      { ...options, branch: 'moving-task' }), true);
    assert.equal(await openedRoot({ target: topicSwitcher.commands.calls.at(-1)[1].fsPath }), moved);
    assert.equal(git('-C', root, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(fromTopic, 'draft.txt'), 'utf8'), 'untracked task work\n');
    assert.equal(git('-C', fromTopic, 'diff', '--cached'), topicIndex);
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
    // Clones do not inherit local author identity; avoid runner defaults.
    git('-C', legacy, 'config', 'user.name', 'Test');
    git('-C', legacy, 'config', 'user.email', 'test@example.invalid');
    git('-C', legacy, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
    assert.equal(await reconnectManagedMain(editor(legacy), options), true, 'Clean legacy main reconnects to the original');
    await fs.writeFile(path.join(legacy, 'file.txt'), 'separate old edits\n');
    await assert.rejects(reconnectManagedMain(editor(legacy), options), /separate pending edits/);
    assert.equal(await fs.readFile(path.join(legacy, 'file.txt'), 'utf8'), 'separate old edits\n');
    git('-C', legacy, 'add', 'file.txt');
    git('-C', legacy, 'commit', '-m', 'Unpublished legacy-only commit');
    // A legacy clone can own linked worktrees too. Selecting an occupied
    // branch must navigate to its existing checkout, not Git checkout again.
    const legacyTopic = path.join(temporary, 'legacy-linked-topic');
    git('-C', legacy, 'worktree', 'add', '-b', 'legacy-topic', legacyTopic);
    await fs.writeFile(path.join(legacyTopic, 'only-here.txt'), 'pending topic file\n');
    const legacySwitcher = editor(legacy);
    assert.equal(await routeBranch(legacySwitcher, { rootUri: { fsPath: legacy } },
      { ...options, branch: 'legacy-topic' }), true);
    assert.equal(await openedRoot({ target: legacySwitcher.commands.calls.at(-1)[1].fsPath }),
      legacyTopic, 'Legacy clone reuses the worktree in its own Git database');
    assert.equal(git('-C', legacy, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(legacyTopic, 'only-here.txt'), 'utf8'),
      'pending topic file\n', 'Existing untracked files remain in that worktree');
    await assert.rejects(reconnectManagedMain(editor(legacy), options), /separate commits/,
      'A legacy clone cannot be reconnected just because its own main contains its commit');
    assert.equal(await reconnectManagedMain(editor(topic), options), false, 'Topic windows stay disconnected');
    git('-C', root, 'switch', '-c', 'external-topic');
    await fs.writeFile(path.join(root, 'file.txt'), 'original topic edits\n');
    git('-C', root, 'add', 'file.txt');
    await fs.writeFile(path.join(root, 'file.txt'), 'additional unstaged topic edits\n');
    const originalStatus = git('-C', root, 'status', '--porcelain');
    const originalIndex = git('-C', root, 'diff', '--cached');
    const fallbackEditor = editor(root);
    const fallback = await openIndependentWorkspace(fallbackEditor, options);
    const linkedMain = await openedRoot(fallback);
    assert.equal(git('-C', linkedMain, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(linkedMain, 'file.txt'), 'utf8'), 'committed main\n');
    assert.equal(git('-C', linkedMain, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      path.join(root, '.git'), 'Main shares the original Git database, not a clone');
    const mainManifest = JSON.parse(await fs.readFile(
      path.join(path.dirname(linkedMain), '.sweetiebot-workspace.json'), 'utf8'));
    assert.equal(mainManifest.kind, 'main-worktree');
    assert.deepEqual(fallbackEditor.commands.calls.at(-1)[2], { forceNewWindow: true });
    assert.equal(git('-C', root, 'branch', '--show-current'), 'external-topic');
    assert.equal(git('-C', root, 'status', '--porcelain'), originalStatus);
    assert.equal(git('-C', root, 'diff', '--cached'), originalIndex);
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'additional unstaged topic edits\n');
    assert.equal(await reconnectManagedMain(editor(linkedMain), options), false,
      'Existing main worktree must never reconnect to a topic checkout');
    const anotherMain = await openIndependentWorkspace(editor(root), options);
    assert.equal(await openedRoot(anotherMain), linkedMain,
      'A second main window reuses the existing main worktree');
    const legacyFallback = await openIndependentWorkspace(editor(legacy), options);
    assert.equal(await openedRoot(legacyFallback), linkedMain,
      'Legacy clones may reopen the shared linked main worktree');
    const returningFromOriginal = editor(root);
    assert.equal(await routeBranch(returningFromOriginal, { rootUri: { fsPath: root } },
      { ...options, branch: 'main' }), true);
    assert.equal(await openedRoot({ target: returningFromOriginal.commands.calls.at(-1)[1].fsPath }),
      linkedMain, 'Returning to main preserves the original topic checkout');
    const originalTopicEditor = editor(root);
    assert.equal(await routeBranch(originalTopicEditor, { rootUri: { fsPath: root } }, {
      ...options, branch: 'new-from-original-topic', create: true, start: 'refs/heads/main'
    }), true, 'New Branch works when the original checkout is still on a topic');
    const newFromOriginal = await openedRoot({ target: originalTopicEditor.commands.calls.at(-1)[1].fsPath });
    assert.equal(git('-C', newFromOriginal, 'branch', '--show-current'), 'new-from-original-topic');
    assert.equal(git('-C', newFromOriginal, 'rev-parse', 'HEAD'), git('-C', root, 'rev-parse', 'main'));
    assert.equal(git('-C', root, 'branch', '--show-current'), 'external-topic');
    assert.equal(git('-C', root, 'status', '--porcelain'), '');
    assert.equal(git('-C', root, 'diff', '--cached'), '');
    assert.equal(git('-C', newFromOriginal, 'status', '--porcelain'), originalStatus);
    assert.equal(git('-C', newFromOriginal, 'diff', '--cached'), originalIndex);
    console.log('Shared main windows, isolated topics, reconnection and legacy preservation passed.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
