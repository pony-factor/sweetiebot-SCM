'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pruneManagedWorkspaces } = require('../efs/workspace_prune');

const BASE = '/Users/test/Library/Application Support/Sweetiebot/Workspaces';
const GROUP = path.join(BASE, 'pony-ABC123');
const OID = 'b'.repeat(40);
const BASE_OID = 'a'.repeat(40);

function fixture({
  activated = true, ageHours = 2, active = false, dirty = false,
  merged = true, extra = false, unrecognized = false, missingProof = false,
  openPr = false, offline = false, extraBranch = false, stash = false
} = {}) {
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
  if (activated) nodes.set(path.join(GROUP, '.sweetiebot-activated'), 'file');
  if (active) nodes.set(path.join(GROUP, '.sweetiebot-session-999-test.json'), 'file');
  if (extra) nodes.set(path.join(GROUP, 'private-note.txt'), 'file');
  const listing = new Map([
    [BASE, ['pony-ABC123']],
    [GROUP, ['pony', '.sweetiebot-workspace.json', '.sweetiebot-merged',
      ...(activated ? ['.sweetiebot-activated'] : []),
      ...(active ? ['.sweetiebot-session-999-test.json'] : []),
      ...(extra ? ['private-note.txt'] : [])]]
  ]);
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

  for (const [label, config] of Object.entries({
    neverActivated: { activated: false },
    recentlyUsed: { ageHours: 0.1 },
    liveWindow: { active: true },
    unexpectedFiles: { extra: true },
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
  console.log('Guarded merged-workspace cleanup checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
