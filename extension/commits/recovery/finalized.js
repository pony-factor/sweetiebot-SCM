'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');
const path = require('node:path');
const run = promisify(execFile);
const PLACEHOLDER = /^(?:placeholder_[0-9a-f]{16}|💭 Generate local commit message \[[0-9a-f]{16}\])$/;

async function recoveryPlan(root, branch, upstream) {
  const git = async args => (await run('git', args, { cwd: root, timeout: 10000 })).stdout.trim();
  const meta = await git(['rev-parse', '--absolute-git-dir']);
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply',
    'sweetiebot-async-commit.json', 'sweetiebot-background-commit.json']
    .some(name => existsSync(path.join(meta, name)))) return null;
  if (await git(['status', '--porcelain=v1', '--untracked-files=all'])) return null;
  if (await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch) return null;
  const local = await git(['rev-parse', 'HEAD']);
  const remote = await git(['rev-parse', upstream]);
  const incoming = (await git(['rev-list', `${local}..${remote}`])).split('\n').filter(Boolean);
  if (incoming.length !== 1 || incoming[0] !== remote) return null;
  const outgoing = (await git(['rev-list', '--reverse', `${remote}..${local}`])).split('\n').filter(Boolean);
  if (!outgoing.length) return null;
  // A finalized message preserves the tree, parent and original author. Require
  // that exact relationship, rather than inferring equivalence from patch IDs.
  const format = '--format=%T%n%P%n%an%n%ae%n%aI';
  const expected = await git(['show', '-s', format, remote]);
  let matched = false;
  let previous;
  for (const sha of outgoing) {
    const parents = await git(['show', '-s', '--format=%P', sha]);
    if (previous && parents !== previous) return null;
    const subject = await git(['show', '-s', '--format=%s', sha]);
    if (PLACEHOLDER.test(subject)) {
      if (matched || sha !== outgoing[0] || await git(['show', '-s', format, sha]) !== expected) return null;
      matched = true;
    }
    previous = sha;
  }
  if (!matched || PLACEHOLDER.test(await git(['show', '-s', '--format=%s', remote]))) return null;
  // Preview without changing HEAD, the index or the working tree. Recovery must
  // only connect ancestry, with exactly the same resulting tracked contents.
  const result = await git(['merge-tree', '--write-tree', local, remote]);
  const tree = await git(['rev-parse', `${local}^{tree}`]);
  if (result.split('\n')[0] !== tree) return null;
  return { branch, local, remote, tree };
}

module.exports = { recoveryPlan };
