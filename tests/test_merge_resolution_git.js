'use strict';

// Real Git integration, entirely within disposable repositories. GitHub is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { humanSquashMerge } = require('../efs/local_human_squash');
const run = promisify(execFile);

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lindsey-resolution-test-'));
  const working = path.join(root, 'working'), remote = path.join(root, 'remote.git');
  const git = async (...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', '-c', 'user.name=John Wooten',
    '-c', 'user.email=human@example.test', ...args])).stdout.trim();
  try {
    await git('init', '--quiet', '--bare', '--initial-branch=main', remote);
    await git('init', '--quiet', '--initial-branch=main', working);
    const repo = (...args) => git('-C', working, ...args);
    await fs.writeFile(path.join(working, 'file.txt'), 'original\n');
    await repo('add', 'file.txt'); await repo('commit', '--quiet', '-m', 'Initial fixture');
    await repo('remote', 'add', 'origin', remote);
    await repo('checkout', '--quiet', '-b', 'feature');
    await fs.writeFile(path.join(working, 'file.txt'), 'feature\n');
    await repo('commit', '--quiet', '-am', '🐛 Preserve feature\n\nCo-authored-by: Codex <noreply@openai.com>');
    const headSha = await repo('rev-parse', 'HEAD');
    const originalMessage = await repo('show', '-s', '--format=%B', 'HEAD');
    await repo('checkout', '--quiet', 'main');
    await fs.writeFile(path.join(working, 'file.txt'), 'base update\n');
    await repo('commit', '--quiet', '-am', 'Update base fixture');
    const baseSha = await repo('rev-parse', 'HEAD');
    await repo('push', '--quiet', 'origin', 'main', 'feature');
    let merged = false, pushed = false;
    const branch = name => git('--git-dir=' + remote, 'rev-parse', 'refs/heads/' + name);
    const author = { name: 'John Wooten', email: 'human@example.test' };
    const api = async (endpoint, method) => {
      if (endpoint === 'repos/owner/repo') return { allow_rebase_merge: true };
      if (endpoint.includes('/branches/')) return { protected: false, commit: { sha: await branch(endpoint.split('/').at(-1)) } };
      if (endpoint.includes('/pulls?')) return [];
      if (endpoint.includes('/commits?')) return [{ author: { type: 'User', login: 'human' }, commit: { author, message: originalMessage } }];
      if (endpoint.endsWith('/pulls/12/merge') && method === 'PUT') {
        const head = await branch('feature');
        assert.notEqual(head, headSha);
        assert.equal(await git('--git-dir=' + remote, 'rev-parse', head + '^'), baseSha);
        await git('--git-dir=' + remote, 'update-ref', 'refs/heads/main', head, baseSha);
        merged = true;
        return { merged: true, sha: head };
      }
      if (endpoint.includes('/commits/')) return { commit: {
        author, message: await git('--git-dir=' + remote, 'show', '-s', '--format=%B', await branch('main'))
      } };
      if (endpoint.endsWith('/pulls/12')) return {
        state: merged ? 'closed' : 'open', merged, merged_at: merged ? '2026-10-21' : null,
        title: '🐛 Resolve feature', mergeable: pushed,
        head: { ref: 'feature', sha: await branch('feature'), repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', sha: merged ? baseSha : await branch('main'), repo: { full_name: 'owner/repo' } },
        merge_commit_sha: merged ? await branch('main') : null
      };
      throw Error('Unexpected endpoint ' + endpoint);
    };
    const localGit = async (...args) => {
      if (args[0] === 'clone') args[3] = remote;
      const output = await git(...args);
      if (args.includes('push')) pushed = true;
      return output;
    };
    const resolutionPatch = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-base update\n+feature and base update\n';
    const result = await humanSquashMerge('owner/repo', 12, { api, git: localGit,
      expected: { headSha, baseSha, base: 'main', head: 'feature', title: '🐛 Resolve feature' }, resolutionPatch,
      temporaryDirectory: () => fs.mkdtemp(path.join(root, 'executor-')) });
    assert(result.merged);
    assert.equal(await git('--git-dir=' + remote, 'show', 'main:file.txt'), 'feature and base update');
    assert.equal(await git('--git-dir=' + remote, 'show', '-s', '--format=%an <%ae>', 'main'), 'John Wooten <human@example.test>');
    const message = await git('--git-dir=' + remote, 'show', '-s', '--format=%B', 'main');
    assert(message.startsWith('🐛 Resolve feature (#12)\n'));
    assert(message.includes('Co-authored-by: Codex Web <noreply@openai.com>'));
    assert.equal(await repo('status', '--porcelain'), '', 'Source working tree remains untouched');
    assert.equal(await repo('rev-parse', 'HEAD'), baseSha, 'Source branch does not move');
    console.log('Real Git resolution patch, isolated checkout, guarded push and human-author squash passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
