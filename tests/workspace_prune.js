'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pruneManagedWorkspaces, releaseClosedWorktree } = require('../extension/branches/workspace_prune');
const { run: runClosedWorker } = require('../extension/branches/closed_worktree');

const BASE = '/Users/test/Library/Application Support/Sweetiebot/Workspaces';
const GROUP = path.join(BASE, 'pony-ABC123');
const OID = 'b'.repeat(40);
const BASE_OID = 'a'.repeat(40);

function fixture({
  activated = true, ageHours = 2, active = false, dirty = false,
  merged = true, extra = false, unrecognized = false, missingProof = false,
  openPr = false, offline = false, extraBranch = false, stash = false, nested = false, symlinkParent = false,
  unexpectedWorkspaceFile = false
} = {}) {
  const GROUP = nested ? path.join(BASE, 'pony', 'ABC123') : path.join(BASE, 'pony-ABC123');
  const deleted = [], invocations = [];
  const names = ['pony'];
  const manifest = { version: 1, kind: 'independent-clone', repositories: names };
  const proof = { merges: [{
    repository: 'github.com/org/pony', branch: 'feature', base: 'main',
    oid: OID, number: 32
  }] };
  const data = new Map([
    [path.join(GROUP, '.sweetiebot-workspace.json'), JSON.stringify(manifest)],
    [path.join(GROUP, '.sweetiebot-merged', 'pony.json'), JSON.stringify(proof)],
    [path.join(GROUP, '.sweetiebot-session-999-test.json'), '{"pid":999}']
  ]);
  const nodes = new Map([
    [BASE, 'dir'], [GROUP, 'dir'], [path.join(GROUP, 'pony'), 'dir'],
    [path.join(GROUP, '.sweetiebot-workspace.json'), 'file'],
    [path.join(GROUP, '.sweetiebot-merged'), 'dir']
  ]);
  if (!missingProof) nodes.set(path.join(GROUP, '.sweetiebot-merged', 'pony.json'), 'file');
  else data.delete(path.join(GROUP, '.sweetiebot-merged', 'pony.json'));
  if (activated) nodes.set(path.join(GROUP, '.sweetiebot-activated'), 'file');
  if (active) nodes.set(path.join(GROUP, '.sweetiebot-session-999-test.json'), 'file');
  if (extra) nodes.set(path.join(GROUP, 'private-note.txt'), 'file');
  if (unexpectedWorkspaceFile) nodes.set(path.join(GROUP, path.basename(GROUP) + '.code-workspace'), 'file');
  const listing = new Map([
    [BASE, ['pony-ABC123']],
    [GROUP, ['pony', '.sweetiebot-workspace.json', '.sweetiebot-merged',
      ...(activated ? ['.sweetiebot-activated'] : []),
      ...(active ? ['.sweetiebot-session-999-test.json'] : []),
      ...(extra ? ['private-note.txt'] : []),
      ...(unexpectedWorkspaceFile ? [path.basename(GROUP) + '.code-workspace'] : [])]]
  ]);
  if (nested) {
    nodes.set(path.join(BASE, 'pony'), symlinkParent ? 'symlink' : 'dir');
    listing.set(BASE, ['pony']);
    listing.set(path.join(BASE, 'pony'), ['ABC123']);
  }
  function typeInfo(file) {
    const type = nodes.get(file);
    if (!type) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return {
      isDirectory: () => type === 'dir',
      isFile: () => type === 'file',
      isSymbolicLink: () => type === 'symlink',
      mtimeMs: file.endsWith('.sweetiebot-activated') ? 7200000 - ageHours * 3600000 : 0
    };
  }
  const io = {
    lstat: async file => typeInfo(file),
    readFile: async file => {
      if (!data.has(file)) throw new Error('missing');
      return data.get(file);
    },
    readdir: async folder => (listing.get(folder) || []).map(name => ({
      name, ...typeInfo(path.join(folder, name))
    })),
    open: async (file, flags) => {
      assert.equal(flags, 'wx');
      assert.equal(file, path.join(BASE, '.sweetiebot-workspace-prune.lock'));
      return { close: async () => {} };
    },
    rm: async (file, options) => { deleted.push([file, options]); }
  };
  const run = async (cmd, args, cwd) => {
    invocations.push([cmd, ...args]);
    assert.equal(cwd, path.join(GROUP, 'pony'));
    if (cmd === 'gh') {
      if (offline) return null;
      if (args[1] === 'view') return JSON.stringify({
        state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? '2026-10-16' : null,
        baseRefName: 'main', headRefName: 'feature', headRefOid: OID,
        isCrossRepository: false, commits: [{ oid: OID }]
      });
      if (args[1] === 'list') return JSON.stringify(openPr ? [{ number: 33 }] : []);
    }
    if (cmd !== 'git') throw new Error('Unexpected ' + cmd);
    if (args[0] === 'fetch') return '';
    if (args[0] === 'remote') return 'https://github.com/org/pony.git';
    if (args[0] === 'symbolic-ref') return 'main';
    if (args[0] === 'for-each-ref') return extraBranch ? 'main\nfeature' : 'main';
    if (args[0] === 'status') return dirty ? '?? new.txt' : '';
    if (args[0] === 'rev-parse') return stash ? BASE_OID : null;
    if (args[0] === 'rev-list') return '0';
    if (args[0] === 'reflog') return OID + '\n' + (unrecognized ? 'c'.repeat(40) : BASE_OID);
    if (args[0] === 'merge-base') {
      const candidate = args[2];
      const target = args[3];
      if (candidate === 'HEAD') return '';
      if (candidate === BASE_OID && target === 'refs/remotes/origin/main') return '';
      if (candidate === OID && target === OID) return '';
      return null;
    }
    throw new Error('Unexpected Git command ' + args.join(' '));
  };
  return {
    deleted, invocations,
    scan: () => pruneManagedWorkspaces({
      baseDirectory: BASE, io, run, now: 7200000, alive: pid => pid === 999, log() {}
    })
  };
}

(async () => {
  const good = fixture();
  assert.deepEqual(await good.scan(), [GROUP], 'Only verified, idle, clean clones are pruned');
  assert(good.deleted.some(([file, options]) => file === GROUP && options.recursive));

  const nested = fixture({ nested: true });
  assert.deepEqual(await nested.scan(), [path.join(BASE, 'pony', 'ABC123')]);
  const linked = fixture({ nested: true, symlinkParent: true });
  assert.deepEqual(await linked.scan(), [], 'Symlinked repository parents are preserved');
  const nestedDirty = fixture({ nested: true, dirty: true });
  assert.deepEqual(await nestedDirty.scan(), [], 'Nested dirty clones are preserved');

  for (const [label, config] of Object.entries({
    neverActivated: { activated: false },
    recentlyUsed: { ageHours: 0.1 },
    liveWindow: { active: true },
    unexpectedFiles: { extra: true },
    unexpectedWorkspaceFile: { unexpectedWorkspaceFile: true },
    unmergedPR: { merged: false },
    openPR: { openPr: true },
    githubOffline: { offline: true },
    dirtyClone: { dirty: true },
    extraBranch: { extraBranch: true },
    stash: { stash: true },
    unknownCommits: { unrecognized: true },
    missingProof: { missingProof: true }
  })) {
    const sample = fixture(config);
    assert.deepEqual(await sample.scan(), [], label + ' must preserve clone');
    assert(!sample.deleted.some(([file]) => file === GROUP), label + ' must not remove group');
  }
  // Shared-main metadata is safe to prune, but edited workspace files and
  // running VS Code sessions protect the whole group.
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-pruner-kinds-'));
  try {
    const base = path.join(temp, 'Workspaces');
    const original = path.join(temp, 'original');
    const workspace = path.join(base, 'repo', 'main-teal');
    const workspaceFile = path.join(workspace, 'main-teal.code-workspace');
    const stamp = path.join(workspace, '.sweetiebot-activated');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(original);
    const content = JSON.stringify({ folders: [{ path: original }] }, null, 2) + '\n';
    const manifest = { version: 1, kind: 'shared-main', repositories: [],
      workspaceFileContents: content };
    await fs.writeFile(path.join(workspace, '.sweetiebot-workspace.json'), JSON.stringify(manifest));
    await fs.writeFile(workspaceFile, content);
    await fs.writeFile(stamp, 'Activated');
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stamp, older, older);
    const neverRunGit = async () => { throw Error('Metadata must not invoke Git'); };
    await fs.appendFile(workspaceFile, ' ');
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, alive: () => false, run: neverRunGit
    }), [], 'Edited workspace settings must be preserved');
    await fs.writeFile(workspaceFile, content);
    await fs.writeFile(path.join(workspace, '.sweetiebot-session-12-test.json'), '{"pid":12}');
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, alive: pid => pid === 12, run: neverRunGit
    }), [], 'Live workspace sessions must be preserved');
    await fs.rm(path.join(workspace, '.sweetiebot-session-12-test.json'));
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, alive: () => false, run: neverRunGit
    }), [workspace], 'Idle shared-main metadata should be pruned');
    assert.equal(await fs.readFile(path.join(original, '.missing')).then(
      () => true, () => false), false, 'Original checkout must never be deleted');
    assert.equal((await fs.stat(original)).isDirectory(), true);

    const group = path.join(base, 'repo', 'topic-id');
    const checkout = path.join(group, 'repo');
    await fs.mkdir(checkout, { recursive: true });
    await fs.mkdir(path.join(original, '.git'));
    await fs.writeFile(path.join(group, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind: 'topic-worktree', repositories: ['repo'], branch: 'topic'
    }));
    await fs.writeFile(path.join(group, '.sweetiebot-activated'), 'Activated');
    await fs.utimes(path.join(group, '.sweetiebot-activated'), older, older);
    const sha = 'a'.repeat(40), operations = [];
    let approved = true, dirty = false;
    const run = async (binary, args, cwd) => {
      operations.push([binary, ...args]);
      if (binary === 'gh') {
        if (args[1] === 'view') return JSON.stringify({
          state: approved ? 'MERGED' : 'OPEN', mergedAt: approved ? '2026-10-20' : null,
          baseRefName: 'main', headRefName: 'topic', headRefOid: sha,
          isCrossRepository: false
        });
        if (args.includes('open')) return '[]';
        return '[{"number":123}]';
      }
      assert.equal(binary, 'git');
      switch (args[0]) {
        case 'rev-parse':
          if (args[1] === '--show-toplevel') return checkout;
          if (args[1] === '--path-format=absolute') return path.join(original, '.git');
          if (args[1] === '--verify') return null; // No stashes.
          return sha;
        case 'symbolic-ref': return 'topic';
        case 'worktree':
          if (args[1] === 'list') return 'worktree ' + checkout +
            '\nHEAD ' + sha + '\nbranch refs/heads/topic\n\n';
          if (args[1] === 'remove') {
            await fs.rm(checkout, { recursive: true });
            return '';
          }
          break;
        case 'status': return dirty ? '?? user-file' : '';
        case 'remote': return 'https://github.com/org/repo.git';
        case 'fetch': return '';
        case 'branch': return '';
      }
      throw Error('Unexpected operation: ' + args.join(' '));
    };
    const saved = path.join(base, 'repo', 'main-rose');
    const savedWorkspaceFile = path.join(saved, 'main-rose.code-workspace');
    await fs.mkdir(saved);
    await fs.writeFile(path.join(saved, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind: 'shared-main', repositories: [],
      workspaceFileContents: JSON.stringify({ folders: [{ path: checkout }] })
    }));
    await fs.writeFile(savedWorkspaceFile,
      JSON.stringify({ folders: [{ path: checkout }] }));
    // This saved workspace has never activated; preserve it and the target.
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run, alive: () => false
    }), [], 'A saved workspace reference protects its topic worktree');
    await fs.rm(saved, { recursive: true });
    // Existing windows using the historical filename still protect worktrees.
    const legacySaved = path.join(base, 'repo', 'legacy-window');
    await fs.mkdir(legacySaved);
    await fs.writeFile(path.join(legacySaved, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind: 'shared-main', repositories: []
    }));
    await fs.writeFile(path.join(legacySaved, 'workspace.code-workspace'),
      JSON.stringify({ folders: [{ path: checkout }] }));
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run, alive: () => false
    }), [], 'A legacy saved workspace reference protects its topic worktree');
    await fs.rm(legacySaved, { recursive: true });
    dirty = true;
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run, alive: () => false
    }), [], 'Dirty worktrees must be preserved');
    dirty = false;
    approved = false;
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run, alive: () => false
    }), [], 'Unmerged topic branches must be preserved');
    approved = true;
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run, alive: () => false
    }), [group], 'Merged, clean, idle topic worktrees are safely detached');
    assert(operations.some(args => args[0] === 'git' && args[1] === 'worktree' &&
      args[2] === 'remove'), 'Git, rather than recursive deletion, detaches worktrees');
    assert(operations.some(args => args[0] === 'git' && args[1] === 'branch' &&
      args[2] === '-D'), 'Verified squash-merged topic branch is retired');

    // An unused temporary main checkout is removed only when its HEAD is
    // already included in origin/main; local unpublished commits protect it.
    const mainGroup = path.join(base, 'repo', 'main-id');
    const mainCheckout = path.join(mainGroup, 'repo');
    await fs.mkdir(mainCheckout, { recursive: true });
    await fs.writeFile(path.join(mainGroup, '.sweetiebot-workspace.json'), JSON.stringify({
      version: 1, kind: 'main-worktree', repositories: ['repo']
    }));
    await fs.writeFile(path.join(mainGroup, '.sweetiebot-activated'), 'Activated');
    await fs.utimes(path.join(mainGroup, '.sweetiebot-activated'), older, older);
    let published = false;
    const mainOperations = [];
    const mainRun = async (binary, args) => {
      mainOperations.push([binary, ...args]);
      assert.equal(binary, 'git', 'Main cleanup does not require a PR');
      switch (args[0]) {
        case 'rev-parse':
          if (args[1] === '--show-toplevel') return mainCheckout;
          if (args[1] === '--path-format=absolute') return path.join(original, '.git');
          if (args[1] === '--verify') return null;
          return sha;
        case 'symbolic-ref': return 'main';
        case 'worktree':
          if (args[1] === 'list') return 'worktree ' + mainCheckout +
            '\nHEAD ' + sha + '\nbranch refs/heads/main\n\n';
          if (args[1] === 'remove') {
            await fs.rm(mainCheckout, { recursive: true });
            return '';
          }
          break;
        case 'status': return '';
        case 'remote': return 'https://github.com/org/repo.git';
        case 'fetch': return '';
        case 'merge-base': return published ? '' : null;
      }
      throw Error('Unexpected main Git command: ' + args.join(' '));
    };
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run: mainRun, alive: () => false
    }), [], 'Unpublished main commits protect the worktree');
    published = true;
    assert.deepEqual(await pruneManagedWorkspaces({
      baseDirectory: base, run: mainRun, alive: () => false
    }), [mainGroup], 'Clean, published, closed main worktrees are detached');
    assert(mainOperations.some(args => args[1] === 'worktree' && args[2] === 'remove'));

  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }


  // Window shutdown detaches clean managed checkouts without deleting an
  // unmerged branch, its unpublished commits, or the original repository.
  const closedBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-closed-worktree-'));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  try {
    const source = path.join(closedBase, 'source');
    const managed = path.join(closedBase, 'Workspaces');
    const group = path.join(managed, 'repo', 'topic-blue');
    const checkout = path.join(group, 'repo');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(group, { recursive: true });
    git('init', '-b', 'main', source);
    git('-C', source, 'config', 'user.name', 'Test');
    git('-C', source, 'config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(source, 'tracked.txt'), 'unchanged\n');
    git('-C', source, 'add', 'tracked.txt');
    git('-C', source, 'commit', '-m', 'Fixture');
    git('-C', source, 'worktree', 'add', '-b', 'topic', checkout);
    await fs.writeFile(path.join(checkout, 'tracked.txt'), 'published later\n');
    git('-C', checkout, 'add', 'tracked.txt');
    git('-C', checkout, 'commit', '-m', 'Preserve local topic commit');
    const topicHead = git('-C', checkout, 'rev-parse', 'HEAD');
    assert.notEqual(topicHead, git('-C', source, 'rev-parse', 'HEAD'));
    await fs.writeFile(path.join(group, '.sweetiebot-workspace.json'),
      JSON.stringify({ version: 1, kind: 'topic-worktree', repositories: ['repo'] }));
    const stamp = path.join(group, '.sweetiebot-activated');
    await fs.writeFile(stamp, 'Activated\n');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await fs.utimes(stamp, old, old);
    const options = { baseDirectory: managed };

    // Dirty files, recent activity, active sessions, and saved workspace
    // references must all prevent automatic checkout removal.
    await fs.writeFile(path.join(checkout, 'not-committed.txt'), 'unsaved\n');
    assert.equal(await releaseClosedWorktree(group, options), false);
    await fs.rm(path.join(checkout, 'not-committed.txt'));
    await fs.utimes(stamp, new Date(), new Date());
    assert.equal(await releaseClosedWorktree(group, options), false);
    await fs.utimes(stamp, old, old);
    const session = path.join(group, '.sweetiebot-session-' + process.pid + '-test.json');
    await fs.writeFile(session, JSON.stringify({ pid: process.pid }));
    assert.equal(await releaseClosedWorktree(group, options), false);
    await fs.rm(session);
    const saved = path.join(managed, 'repo', 'main-teal');
    await fs.mkdir(saved);
    await fs.writeFile(path.join(saved, '.sweetiebot-workspace.json'),
      JSON.stringify({ version: 1, kind: 'shared-main', repositories: [] }));
    await fs.writeFile(path.join(saved, 'main-teal.code-workspace'),
      JSON.stringify({ folders: [{ path: checkout }] }));
    assert.equal(await releaseClosedWorktree(group, options), false);
    await fs.rm(saved, { recursive: true });

    assert.equal(await releaseClosedWorktree(group, options), true);
    assert.equal(git('-C', source, 'rev-parse', 'refs/heads/topic'), topicHead,
      'An unpublished local branch commit survives worktree detachment');
    assert(!git('-C', source, 'worktree', 'list', '--porcelain').includes(checkout));
    assert.equal((await fs.stat(source)).isDirectory(), true);
    assert.equal(await fs.stat(group).then(() => true, () => false), false);
    const visited = [];
    await runClosedWorker([group, group], {
      async wait(ms) { assert.equal(ms, 120000); },
      async release(folder) { visited.push(folder); }
    });
    assert.deepEqual(visited, [group], 'Close-worker deduplicates groups and delays removal');
  } finally {
    await fs.rm(closedBase, { recursive: true, force: true });
  }

  console.log('Guarded merged-workspace and closed-worktree cleanup checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
