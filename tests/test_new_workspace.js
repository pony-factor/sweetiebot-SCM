'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openIndependentClone: openIndependentWorkspace } = require('../efs/new_workspace');

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
async function makeRepo(root, branch = 'main') {
  await fs.mkdir(root, { recursive: true });
  git('init', '-b', branch, root);
  git('-C', root, 'config', 'user.name', 'Sweetiebot Test');
  git('-C', root, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'main snapshot\n');
  git('-C', root, 'add', 'tracked.txt');
  git('-C', root, 'commit', '-m', 'Initial snapshot');
}
function editor(paths) {
  const calls = [];
  return {
    calls,
    workspace: { workspaceFolders: paths.map((p, i) => ({
      name: 'Folder ' + (i + 1), uri: { scheme: 'file', fsPath: p }
    })) },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    commands: { async executeCommand(...args) { calls.push(args); } }
  };
}

(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-new-workspace-test-'));
  try {
    const original = path.join(tmp, 'original');
    const copies = path.join(tmp, 'copies');
    await makeRepo(original);
    git('-C', original, 'switch', '-c', 'topic');
    await fs.writeFile(path.join(original, 'tracked.txt'), 'topic snapshot\n');
    git('-C', original, 'commit', '-am', 'Topic snapshot');
    await fs.writeFile(path.join(original, 'dirty.txt'), 'leave untouched\n');

    const first = editor([original]);
    const initial = await openIndependentWorkspace(first, { baseDirectory: copies });
    assert.equal(first.calls[0][0], 'vscode.openFolder');
    assert.deepEqual(first.calls[0][2], { forceNewWindow: true });
    const clone = first.calls[0][1].fsPath;
    assert.equal(clone, initial.target);
    const manifest = JSON.parse(await fs.readFile(path.join(initial.directory, '.sweetiebot-workspace.json'), 'utf8'));
    assert.deepEqual(manifest.repositories, ['original']);
    assert.equal(manifest.kind, 'independent-clone');
    assert.equal(path.basename(clone), 'original', 'No ordinal prefix on the checkout');
    assert.match(path.basename(initial.directory), /^original-[a-zA-Z0-9_-]+$/, 'Parent uses the repository name');
    assert.equal(git('-C', clone, 'branch', '--show-current'), 'main');
    assert.equal(await fs.readFile(path.join(clone, 'tracked.txt'), 'utf8'), 'main snapshot\n');
    assert.equal(git('-C', original, 'branch', '--show-current'), 'topic');
    assert.equal(await fs.readFile(path.join(original, 'dirty.txt'), 'utf8'), 'leave untouched\n');
    assert.equal(git('-C', clone, 'remote'), '', 'Never point a clone back at the source checkout');
    git('-C', clone, 'switch', 'topic');

    git('-C', original, 'switch', 'main');
    const another = await openIndependentWorkspace(editor([original]), { baseDirectory: copies });
    assert.equal(git('-C', another.target, 'branch', '--show-current'), 'main');
    git('-C', another.target, 'switch', 'topic');
    assert.equal(git('-C', original, 'branch', '--show-current'), 'main');
    assert.equal(git('-C', clone, 'branch', '--show-current'), 'topic');

    const upstream = path.join(tmp, 'upstream.git');
    git('init', '--bare', upstream);
    git('-C', original, 'remote', 'add', 'origin', upstream);
    const withRemote = await openIndependentWorkspace(editor([original]), { baseDirectory: copies });
    assert.equal(git('-C', withRemote.target, 'remote', 'get-url', 'origin'), upstream);

    const otherRepo = path.join(tmp, 'other');
    await makeRepo(otherRepo);
    const combined = await openIndependentWorkspace(editor([original, otherRepo]), { baseDirectory: copies });
    assert.ok(combined.target.endsWith('.code-workspace'));
    const data = JSON.parse(await fs.readFile(combined.target, 'utf8'));
    assert.equal(data.folders.length, 2);
    assert.match(path.basename(combined.directory), /^original-group-[a-zA-Z0-9_-]+$/);
    assert.deepEqual(data.folders.map(folder => path.basename(folder.path)), ['original', 'other']);
    assert.equal(git('-C', data.folders[0].path, 'branch', '--show-current'), 'main');
    assert.equal(git('-C', data.folders[1].path, 'branch', '--show-current'), 'main');

    // Two unrelated repositories with the same basename should remain
    // separate, readable checkouts without numeric prefixes or overwrites.
    const duplicateOne = path.join(tmp, 'first', 'shared');
    const duplicateTwo = path.join(tmp, 'second', 'shared');
    await makeRepo(duplicateOne);
    await makeRepo(duplicateTwo);
    const sameName = await openIndependentWorkspace(editor([duplicateOne, duplicateTwo]), {
      baseDirectory: copies
    });
    const namedFolders = JSON.parse(await fs.readFile(sameName.target, 'utf8')).folders;
    assert.deepEqual(namedFolders.map(folder => path.basename(folder.path)), ['shared', 'shared-2']);
    assert.equal(git('-C', namedFolders[0].path, 'branch', '--show-current'), 'main');
    assert.equal(git('-C', namedFolders[1].path, 'branch', '--show-current'), 'main');
    assert.notEqual(namedFolders[0].path, namedFolders[1].path);
    assert.notEqual(initial.directory, another.directory, 'Repeated launches keep distinct workspaces');

    const noMain = path.join(tmp, 'no-main');
    await makeRepo(noMain, 'development');
    await assert.rejects(
      openIndependentWorkspace(editor([noMain]), { baseDirectory: copies }),
      /has no local main branch/
    );
    await assert.rejects(
      openIndependentWorkspace(editor([path.join(tmp, 'not-a-repo')]), { baseDirectory: copies }),
      /not inside a local Git repository/
    );
    console.log('Independent main workspace checkout and branch isolation checks passed.');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
