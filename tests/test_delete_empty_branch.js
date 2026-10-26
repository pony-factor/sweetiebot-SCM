'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { deleteBranch, deleteEmptyBranch, remoteBranchTip, deletePublishedBranch,
  deleteUnverifiedLocalBranch, confirmUnverifiedLocalDeletion, registerBranchCommands } = require('../efs/branches/branch_actions');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-delete-empty-'));
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
}).trim();

function fixture(name, published = false) {
  const base = path.join(directory, name);
  fs.mkdirSync(base);
  const remote = path.join(base, 'remote.git');
  const local = path.join(base, 'local');
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(base, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Test');
  git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(local, 'base.txt'), 'base\n');
  git(local, 'add', '.');
  git(local, 'commit', '-m', 'Initial');
  git(local, 'push', '-u', 'origin', 'main');
  git(local, 'checkout', '-b', 'topic');
  if (published) git(local, 'push', '-u', 'origin', 'topic');
  const repository = {
    rootUri: { fsPath: local }, state: {},
    async status() { this.state.HEAD = { name: git(local, 'branch', '--show-current') }; },
    async getBranch(branch) {
      assert.equal(branch, 'main');
      return { upstream: { remote: 'origin', name: 'main' } };
    },
    async fetch({ remote: target, ref, prune }) {
      git(local, 'fetch', ...(prune ? ['--prune'] : []), target, ...(ref ? [ref] : []));
    },
    async getRefs({ pattern }) {
      return git(local, 'for-each-ref', '--format=%(refname:short)', pattern)
        .split('\n').filter(Boolean).map(name => ({ name }));
    },
    async checkout(branch) { git(local, 'checkout', branch); await this.status(); },
    async deleteBranch(branch, force) { git(local, 'branch', force ? '-D' : '-d', branch); }
  };
  const remoteBranch = () => git(base, '--git-dir', remote, 'branch', '--list', 'topic');
  const localBranch = () => git(local, 'branch', '--list', 'topic');
  return { base, remote, local, repository, remoteBranch, localBranch };
}

function orphanedTopic(name) {
  const f = fixture(name, true);
  fs.writeFileSync(path.join(f.local, 'topic.txt'), 'Unique PR work\n');
  git(f.local, 'add', '.');
  git(f.local, 'commit', '-m', 'PR-only change');
  git(f.local, 'push', 'origin', 'topic');
  git(f.local, 'push', 'origin', '--delete', 'topic');
  return f;
}

async function run() {
  const opts = { branch: 'topic', defaultBranch: 'main', remote: 'origin' };
  {
    const f = fixture('local-only');
    assert.deepEqual(await deleteEmptyBranch(f.repository, opts), { branch: 'topic', remoteDeleted: false });
    assert.equal(f.localBranch(), '');
    assert.equal(f.remoteBranch(), '');
    assert.equal(git(f.local, 'branch', '--show-current'), 'main');
  }
  {
    const f = fixture('published', true);
    assert.deepEqual(await deleteEmptyBranch(f.repository, opts), { branch: 'topic', remoteDeleted: true });
    assert.equal(f.localBranch(), '');
    assert.equal(f.remoteBranch(), '');
  }
  {
    // Deleting a stale empty branch should not rewrite unpublished main commits.
    const f = fixture('local-main-ahead', true);
    git(f.local, 'checkout', 'main');
    fs.writeFileSync(path.join(f.local, 'base.txt'), 'local advance\n');
    git(f.local, 'commit', '-am', 'Main only');
    const newMain = git(f.local, 'rev-parse', 'HEAD');
    git(f.local, 'checkout', 'topic');
    assert.equal((await deleteEmptyBranch(f.repository, opts)).remoteDeleted, true);
    assert.equal(git(f.local, 'rev-parse', 'main'), newMain);
    assert.equal(f.localBranch(), '');
  }
  {
    const f = fixture('topic-commits', true);
    fs.writeFileSync(path.join(f.local, 'topic.txt'), 'unique commit\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'Unique topic');
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /contains commits/);
    assert(f.localBranch());
    assert(f.remoteBranch());
    assert.equal(git(f.local, 'branch', '--show-current'), 'topic');
  }
  {
    const f = fixture('dirty', true);
    fs.writeFileSync(path.join(f.local, 'draft.txt'), 'do not drop this\n');
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /Commit, stash, or discard/);
    assert(f.localBranch());
    assert(f.remoteBranch());
    assert.equal(fs.readFileSync(path.join(f.local, 'draft.txt'), 'utf8'), 'do not drop this\n');
  }
  {
    const f = fixture('remote-ahead', true);
    const other = path.join(f.base, 'other');
    git(f.base, 'clone', f.remote, other);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.invalid');
    git(other, 'checkout', 'topic');
    fs.writeFileSync(path.join(other, 'new.txt'), 'remote change\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'Remote unique');
    git(other, 'push');
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /tip differs/);
    assert(f.localBranch());
    assert(f.remoteBranch());
    assert.equal(git(f.local, 'branch', '--show-current'), 'topic');
  }
  {
    // A remote push between preflight and deletion must defeat the exact-SHA lease.
    const f = fixture('lease', true);
    const other = path.join(f.base, 'other');
    git(f.base, 'clone', f.remote, other);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.invalid');
    git(other, 'checkout', 'topic');
    f.repository.checkout = async branch => {
      git(f.local, 'checkout', branch);
      await f.repository.status();
      fs.writeFileSync(path.join(other, 'new.txt'), 'concurrent update\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'New remote commit');
      git(other, 'push');
    };
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /stale info|rejected|fetch first|failed to push/i);
    assert(f.localBranch(), 'Keep local branch if remote deletion fails');
    assert(f.remoteBranch());
  }
  {
    const f = fixture('default-guard');
    await assert.rejects(deleteEmptyBranch(f.repository, { ...opts, branch: 'main' }), /non-default/);
    assert(f.localBranch());
  }

  {
    // The trash action must ask before deleting a published branch with PR commits.
    const f = fixture('published-confirmation', true);
    fs.writeFileSync(path.join(f.local, 'pr.txt'), 'PR work\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'PR commit');
    git(f.local, 'push', 'origin', 'topic');
    let allow = false;
    const notices = [];
    const commands = new Map();
    const vscode = {
      Uri: { from(value) { return value.rootUri || value; } },
      extensions: { getExtension() { return { async activate() { return {
        getAPI() { return { getRepository() { return f.repository; } }; }
      }; } }; } },
      commands: { registerCommand(id, callback) {
        commands.set(id, callback);
        return { dispose() {} };
      } },
      window: { async showWarningMessage(message, options, action) {
        notices.push({ message, options, action });
        return allow ? 'Delete Local and Remote' : undefined;
      } }
    };
    registerBranchCommands(vscode, { subscriptions: [] });
    const trash = commands.get('sweetiebot.deleteBranch');
    assert.equal(await trash({ rootUri: f.repository.rootUri }, opts), false);
    assert(f.localBranch(), 'Cancel must retain the local branch');
    assert(f.remoteBranch(), 'Cancel must retain origin');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].options.modal, true);
    assert(notices[0].options.detail.includes('origin/topic'));
    assert.match(notices[0].options.detail, /pull request/);
    allow = true;
    assert.deepEqual(await trash({ rootUri: f.repository.rootUri }, opts),
      { branch: 'topic', remoteDeleted: true });
    assert.equal(f.localBranch(), '');
    assert.equal(f.remoteBranch(), '');
    assert.equal(git(f.local, 'branch', '--show-current'), 'main');
  }
  {
    const f = fixture('published-dirty', true);
    const tip = await remoteBranchTip(f.repository, 'topic');
    fs.writeFileSync(path.join(f.local, 'unsaved.txt'), 'keep me\n');
    await assert.rejects(deletePublishedBranch(f.repository, { ...opts, expectedRemoteTip: tip }),
      /Commit, stash, or discard/);
    assert(f.localBranch());
    assert(f.remoteBranch());
  }
  {
    const f = fixture('published-tip-mismatch', true);
    const tip = await remoteBranchTip(f.repository, 'topic');
    fs.writeFileSync(path.join(f.local, 'unpublished.txt'), 'local only\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'Not published');
    await assert.rejects(deletePublishedBranch(f.repository, { ...opts, expectedRemoteTip: tip }),
      /tips differ/);
    assert(f.localBranch());
    assert(f.remoteBranch());
  }
  {
    const f = fixture('published-stale-confirmation', true);
    const tip = await remoteBranchTip(f.repository, 'topic');
    const other = path.join(f.base, 'other');
    git(f.base, 'clone', f.remote, other);
    git(other, 'config', 'user.name', 'Test');
    git(other, 'config', 'user.email', 'test@example.invalid');
    git(other, 'checkout', 'topic');
    fs.writeFileSync(path.join(other, 'new.txt'), 'remote advanced\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'Remote advanced');
    git(other, 'push', 'origin', 'topic');
    await assert.rejects(deletePublishedBranch(f.repository, { ...opts, expectedRemoteTip: tip }),
      /tip changed after confirmation/);
    assert(f.localBranch());
    assert(f.remoteBranch());
  }
  {
    // A push after preflight still cannot bypass Git's remote SHA lease.
    const f = fixture('published-lease-race', true);
    const tip = await remoteBranchTip(f.repository, 'topic');
    const other = path.join(f.base, 'other');
    git(f.base, 'clone', f.remote, other);
    git(other, 'config', 'user.name', 'Test');
    git(other, 'config', 'user.email', 'test@example.invalid');
    git(other, 'checkout', 'topic');
    const checkout = f.repository.checkout.bind(f.repository);
    f.repository.checkout = async branch => {
      await checkout(branch);
      fs.writeFileSync(path.join(other, 'race.txt'), 'new upstream commit\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'Racing push');
      git(other, 'push', 'origin', 'topic');
    };
    await assert.rejects(deletePublishedBranch(f.repository, { ...opts, expectedRemoteTip: tip }),
      /stale info|rejected|fetch first|failed to push/i);
    assert(f.localBranch(), 'The local branch survives a failed remote deletion');
    assert(f.remoteBranch());
  }
  {
    const f = fixture('published-protect-default', true);
    const tip = git(f.local, 'rev-parse', 'main');
    await assert.rejects(deletePublishedBranch(f.repository, {
      ...opts, branch: 'main', expectedRemoteTip: tip
    }), /non-default/);
    assert(f.localBranch());
    assert(f.remoteBranch());
  }


  {
    // Reproduce the exact post-checkout failure after remote deletion and a
    // squash merge: the PR cleaner cannot prove the original topic tip.
    const f = orphanedTopic('unverified-cancel');
    const prompts = [];
    const vscode = { window: { async showWarningMessage(...args) {
      prompts.push(args);
      return undefined;
    } } };
    const result = await deleteBranch(f.repository, {
      ...opts, confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, f.repository, opts)
    }, async () => {});
    assert.equal(result, false, 'Cancel must not delete local commits');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0][0], /unverified local branch/);
    assert.equal(prompts[0][1].modal, true);
    assert.match(prompts[0][1].detail, /unmerged commits/);
    assert.equal(prompts[0][2], 'Delete Local Branch Anyway');
    assert(f.localBranch());
    assert.equal(f.remoteBranch(), '');
    assert.equal(git(f.local, 'branch', '--show-current'), 'main');
  }
  {
    const f = orphanedTopic('unverified-confirmed');
    const vscode = { window: { async showWarningMessage() { return 'Delete Local Branch Anyway'; } } };
    assert.deepEqual(await deleteBranch(f.repository, {
      ...opts, confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, f.repository, opts)
    }, async () => {}), { branch: 'topic', remoteDeleted: false, unverifiedDeleted: true });
    assert.equal(f.localBranch(), '');
    assert.equal(f.remoteBranch(), '');
    assert.equal(git(f.local, 'branch', '--show-current'), 'main');
  }
  {
    // Do not delete a branch whose tip changes while the modal is open.
    const f = orphanedTopic('unverified-race');
    const vscode = { window: { async showWarningMessage() {
      git(f.local, 'branch', '-f', 'topic', 'main');
      return 'Delete Local Branch Anyway';
    } } };
    await assert.rejects(deleteBranch(f.repository, {
      ...opts, confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, f.repository, opts)
    }, async () => {}), /tip changed after confirmation/);
    assert(f.localBranch());
  }
  {
    // A branch republished during confirmation must use the SHA-leased route.
    const f = orphanedTopic('unverified-republished');
    const vscode = { window: { async showWarningMessage() {
      git(f.local, 'push', 'origin', 'refs/heads/topic:refs/heads/topic');
      return 'Delete Local Branch Anyway';
    } } };
    await assert.rejects(deleteBranch(f.repository, {
      ...opts, confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, f.repository, opts)
    }, async () => {}), /remote branch reappeared/);
    assert(f.localBranch());
    assert(f.remoteBranch());
  }
  {
    const f = orphanedTopic('unverified-dirty');
    const vscode = { window: { async showWarningMessage() {
      fs.writeFileSync(path.join(f.local, 'untracked.txt'), 'unsaved edits\n');
      return 'Delete Local Branch Anyway';
    } } };
    await assert.rejects(deleteBranch(f.repository, {
      ...opts, confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, f.repository, opts)
    }, async () => {}), /Commit, stash, or discard/);
    assert(f.localBranch());
  }
  {
    const f = orphanedTopic('unverified-other-worktree');
    const vscode = { window: { async showWarningMessage() {
      git(f.local, 'worktree', 'add', path.join(f.base, 'additional-worktree'), 'topic');
      return 'Delete Local Branch Anyway';
    } } };
    await assert.rejects(deleteBranch(f.repository, {
      ...opts, confirmUnverified: () => confirmUnverifiedLocalDeletion(vscode, f.repository, opts)
    }, async () => {}), /checked out|worktree/i);
    assert(f.localBranch());
  }
  {
    const f = fixture('unverified-default-protected');
    const tip = git(f.local, 'rev-parse', 'main');
    await assert.rejects(deleteUnverifiedLocalBranch(f.repository, {
      ...opts, branch: 'main', expectedTip: tip
    }), /non-default/);
    assert(f.localBranch());
  }

  console.log('Empty branch deletion regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
