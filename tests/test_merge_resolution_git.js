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
 for (const resolving of [true, false]) {
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
    const firstSha = await repo('rev-parse', 'HEAD');
    const firstMessage = await repo('show', '-s', '--format=%B', 'HEAD');
    await fs.writeFile(path.join(working, 'file.txt'), 'feature continued\n');
    await repo('commit', '--quiet', '-am', '🔧 Complete the feature',
      '--author=codex-pony[bot] <326443430+codex-pony[bot]@users.noreply.github.com>');
    const headSha = await repo('rev-parse', 'HEAD');
    const originalMessage = await repo('show', '-s', '--format=%B', 'HEAD');
    await repo('checkout', '--quiet', 'main');
    await fs.writeFile(path.join(working, resolving ? 'file.txt' : 'base.txt'), 'base update\n');
    await repo('add', resolving ? 'file.txt' : 'base.txt');
    await repo('commit', '--quiet', '-m', 'Update base fixture');
    const baseSha = await repo('rev-parse', 'HEAD');
    await repo('push', '--quiet', 'origin', 'main', 'feature');
    let merged = false, pushed = false;
    let stalePushReads = 0;
    const pushes = [];
    const branch = name => git('--git-dir=' + remote, 'rev-parse', 'refs/heads/' + name);
    const author = { name: 'John Wooten', email: 'human@example.test' };
    const api = async (endpoint, method) => {
      if (endpoint === 'repos/owner/repo') return { allow_rebase_merge: true, default_branch: 'main' };
      if (endpoint.includes('/check-runs?')) return { check_runs: [] };
      if (endpoint.includes('/check-suites?')) return { check_suites: [
        { app: { name: 'Netlify' }, status: 'queued', latest_check_runs_count: 0 },
        { app: { name: 'AWS Amplify' }, status: 'queued', latest_check_runs_count: 0 }
      ] };
      if (endpoint.includes('/status?')) return { statuses: [] };
      if (endpoint.includes('/branches/')) return { protected: false, commit: { sha: await branch(endpoint.split('/').at(-1)) } };
      if (endpoint.includes('/pulls?')) return [];
      if (endpoint.includes('/commits?') && pushed) {
        const shas = (await git('--git-dir=' + remote, 'rev-list', '--reverse', 'main..feature')).split('\n');
        return Promise.all(shas.map(async sha => ({ sha,
          author: { type: sha === headSha ? 'Bot' : 'User', login: sha === headSha ? 'codex-pony[bot]' : 'human' },
          commit: { author: sha === headSha ? { name: 'codex-pony[bot]', email: '326443430+codex-pony[bot]@users.noreply.github.com' } : author,
            message: await git('--git-dir=' + remote, 'show', '-s', '--format=%B', sha) } })));
      }
      if (endpoint.includes('/commits?')) return [
        { sha: firstSha, author: { type: 'User', login: 'human' }, commit: { author, message: firstMessage } },
        { sha: headSha, author: { type: 'Bot', login: 'codex-pony[bot]' }, commit: {
          author: { name: 'codex-pony[bot]', email: '326443430+codex-pony[bot]@users.noreply.github.com' }, message: originalMessage } }
      ];
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
        title: '🐛 Resolve feature', mergeable: !resolving || pushed, user: { type: 'Bot', login: 'codex-pony[bot]' },
        head: { ref: 'feature', sha: pushed && stalePushReads > 0 && --stalePushReads >= 0
          ? headSha : await branch('feature'), repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', sha: merged ? baseSha : await branch('main'), repo: { full_name: 'owner/repo' } },
        merge_commit_sha: merged ? await branch('main') : null
      };
      throw Error('Unexpected endpoint ' + endpoint);
    };
    const localGit = async (...args) => {
      if (args[0] === 'clone') args[3] = remote;
      if (args.includes('push')) pushes.push(args);
      const output = await git(...args);
      if (args.includes('push')) pushed = true;
      return output;
    };
    const completePatch = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-base update\n+feature and base update\n';
    const resolutionPatch = resolving ? completePatch : null;
    const decisions = resolving ? [{ path: 'file.txt', title: '🛠️ Preserve the feature and base update',
      description: 'Keep the updated base behavior and the feature continuation together rather than discarding either side.' }] : [];
    const expected = { headSha, baseSha, base: 'main', head: 'feature', title: '🐛 Resolve feature' };
    const attempt = (overrides = {}) => humanSquashMerge('owner/repo', 12, {
      api, git: localGit, expected, resolutionPatch, decisions,
      temporaryDirectory: () => fs.mkdtemp(path.join(root, 'executor-')), ...overrides
    });
    await assert.rejects(attempt({ expected: { ...expected, headSha: 'a'.repeat(40) } }), /changed/);
    if (resolving) await assert.rejects(attempt({ expected: { ...expected, baseSha: 'b'.repeat(40) } }), /changed|Base changed/);
    await assert.rejects(attempt({ api: async (endpoint, ...rest) => {
      if (endpoint === 'repos/owner/repo') return { allow_rebase_merge: true, default_branch: 'feature' };
      return api(endpoint, ...rest);
    } }), /default branch/);
    await assert.rejects(attempt({ api: async (endpoint, ...rest) => {
      if (endpoint.endsWith('/branches/feature')) return { protected: true };
      return api(endpoint, ...rest);
    } }), /protected/);
    await assert.rejects(attempt({ api: async (endpoint, ...rest) => {
      if (endpoint.includes('/pulls?')) return [{ number: 13, head: {ref: 'child'}, base: { ref: 'feature' } }];
      return api(endpoint, ...rest);
    } }), /#13 \(child → feature\).*depends on.*feature/);
    await assert.rejects(attempt({ api: async (endpoint, ...rest) => {
      if (endpoint.includes('/commits?')) return [{ author: { type: 'Bot', login: 'codex-pony[bot]' },
        commit: { author, message: originalMessage } }];
      return api(endpoint, ...rest);
    } }), /No verified original human/);
    await assert.rejects(attempt({ resolutionPatch: completePatch.replaceAll('file.txt', 'other.txt') }), /unrelated/);
    assert.equal(await branch('feature'), headSha, 'Every blocked preflight leaves the selected branch unchanged');
    assert.equal(await branch('main'), baseSha, 'Every blocked preflight leaves main unchanged');
    // An ordinary fast-forward push must preserve a competing branch update.
    const competing = await git('--git-dir=' + remote, 'commit-tree', headSha + '^{tree}', '-p', headSha, '-m', 'Competing fixture update');
    await assert.rejects(attempt({ git: async (...args) => {
      if (args.includes('push')) await git('--git-dir=' + remote, 'update-ref', 'refs/heads/feature', competing, headSha);
      return localGit(...args);
    } }), /stale info|rejected/);
    assert.equal(await branch('feature'), competing, 'A normal push preserves the competing head');
    await git('--git-dir=' + remote, 'update-ref', 'refs/heads/feature', headSha, competing);
    pushed = false;
    stalePushReads = 2;
    const incremental = await attempt();
    assert.equal(stalePushReads, 0, 'Wait for stale post-push metadata before accepting synchronization');
    assert.equal(incremental.status, 'synced', 'Default integration appends commits');
    assert(!pushes.at(-1).some(arg => arg.startsWith('--force')), 'Incremental updates use an ordinary push');
    await git('--git-dir=' + remote, 'merge-base', '--is-ancestor', headSha, incremental.sha);
    assert.equal(await branch('main'), baseSha);
    const needsApproval = await attempt({ expected: { ...expected, headSha: incremental.sha }, resolutionPatch: null, decisions: [] });
    assert.equal(needsApproval.status, 'blocked');
    assert.match(needsApproval.reason, /explicit local approval/);
    assert.equal(await branch('feature'), incremental.sha, 'Attribution alone cannot trigger an automatic rewrite');
    const wrongReason = await attempt({ expected: { ...expected, headSha: incremental.sha }, resolutionPatch: null,
      decisions: [], allowHistoryRewrite: true, rewriteReason: 'simplify-squash' });
    assert.equal(wrongReason.status, 'blocked', 'Convenience does not qualify as rewrite necessity');
    await git('--git-dir=' + remote, 'update-ref', 'refs/heads/feature', headSha, incremental.sha);
    pushed = false;
    const progress = [];
    stalePushReads = 2;
    let result = await humanSquashMerge('owner/repo', 12, { api, git: localGit,
      onProgress: event => progress.push(event), allowHistoryRewrite: true, rewriteReason: 'preserve-human-author',
      expected: { headSha, baseSha, base: 'main', head: 'feature', title: '🐛 Resolve feature' }, resolutionPatch, decisions,
      temporaryDirectory: () => fs.mkdtemp(path.join(root, 'executor-')) });
    assert.equal(progress[0].stage, 'preparing');
    const pushedIndex = progress.findIndex(event => event.stage === 'pushed');
    assert(pushedIndex > progress.findIndex(event => event.stage === (resolving ? 'sync-prepared' : 'prepared')));
    assert.equal(progress[pushedIndex + 1].stage, 'verifying-push');
    if (resolving) {
      assert(progress.some(event => event.stage === 'decision-commit' && event.path === 'file.txt' && event.title === decisions[0].title));
    } else {
      assert(progress.findIndex(event => event.stage === 'waiting-checks') > pushedIndex);
      assert(progress.findIndex(event => event.stage === 'merging') > progress.findIndex(event => event.stage === 'checks-passed'));
    }
    if (resolving) {
      assert.equal(result.status, 'synced');
      assert.equal(await branch('main'), baseSha, 'Resolution preparation only reads main');
      assert.equal(await git('--git-dir=' + remote, 'rev-parse', result.sha + '^^'), headSha, 'The original PR history is preserved');
      assert.equal(await git('--git-dir=' + remote, 'show', '-s', '--format=%s', result.sha + '^'), decisions[0].title);
      result = await humanSquashMerge('owner/repo', 12, { api, git: localGit,
        expected: { ...expected, headSha: result.sha }, allowHistoryRewrite: true, rewriteReason: 'preserve-human-author',
        temporaryDirectory: () => fs.mkdtemp(path.join(root, 'executor-')) });
    }
    assert(result.merged, JSON.stringify(result));
    assert.equal(await git('--git-dir=' + remote, 'show', 'main:file.txt'), resolving ? 'feature and base update' : 'feature continued');
    assert.equal(await git('--git-dir=' + remote, 'show', '-s', '--format=%an <%ae>', 'main'), 'John Wooten <human@example.test>');
    const message = await git('--git-dir=' + remote, 'show', '-s', '--format=%B', 'main');
    assert(message.startsWith('🐛 Resolve feature (#12)\n'));
    assert(message.includes('Co-authored-by: Codex Web <noreply@openai.com>'));
    assert(message.includes('\n\n__________\n\n'));
    assert(message.indexOf('Co-authored-by: Codex <') < message.indexOf('Co-authored-by: Codex Web <'));
    assert(!message.includes('Co-authored-by: John Wooten'));
    assert(message.includes('Co-authored-by: codex-pony[bot] <326443430+codex-pony[bot]@users.noreply.github.com>'));
    assert(message.indexOf('Co-authored-by: Codex Web <') < message.indexOf('Co-authored-by: codex-pony[bot] <'));
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('executor-')), [], 'All isolated checkouts are cleaned up');
    assert.equal(await repo('status', '--porcelain'), '', 'Source working tree remains untouched');
    assert.equal(await repo('rev-parse', 'HEAD'), baseSha, 'Source branch does not move');
    console.log('Real Git resolution patch, isolated checkout, guarded push and human-author squash passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
 }
 await successiveMerges();
})().catch(error => { console.error(error); process.exitCode = 1; });

async function successiveMerges() {
 const { createMergeBatch } = require('../efs/merge_batch');
 const { executeResolution } = require('../efs/merge_resolution');
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lindsey-successive-test-'));
 const working = path.join(root, 'working'), remote = path.join(root, 'remote.git');
 const git = async (...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null',
   '-c', 'commit.gpgsign=false', '-c', 'user.name=John Wooten',
   '-c', 'user.email=human@example.test', ...args])).stdout.trim();
 let batch;
 try {
   await git('init', '--quiet', '--bare', '--initial-branch=main', remote);
   await git('init', '--quiet', '--initial-branch=main', working);
   const repo = (...args) => git('-C', working, ...args);
   const file = path.join(working, 'price.js');
   await fs.writeFile(file, 'function price(n) { return n * 2; }\n');
   await repo('add', 'price.js'); await repo('commit', '--quiet', '-m', 'Initial fixture');
   const initial = await repo('rev-parse', 'HEAD');
   const heads = {};
   for (const [number, code] of [[1, 'function price(n) { return n * 3; }\n'],
     [2, 'function price(n, tax = 0) { return n * 2 + tax; }\n']]) {
     await repo('checkout', '--quiet', '-B', 'feature-' + number, initial);
     await fs.writeFile(file, code);
     if (number === 1) await fs.writeFile(path.join(working, 'main-only.txt'), 'Independent incoming main work\n');
     if (number === 1) await repo('add', 'main-only.txt');
     await repo('commit', '--quiet', '-am', 'Feature fixture\n\nCo-authored-by: Codex <noreply@openai.com>');
     heads[number] = await repo('rev-parse', 'HEAD');
   }
   await repo('checkout', '--quiet', 'main');
   await repo('remote', 'add', 'origin', remote);
   await repo('push', '--quiet', 'origin', 'main', 'feature-1', 'feature-2');
   const branch = name => git('--git-dir=' + remote, 'rev-parse', 'refs/heads/' + name);
   const author = { name: 'John Wooten', email: 'human@example.test' };
   const merged = new Set();
   const staleCheckHead = heads[2];
   const title = number => number === 1 ? '🐛 Correct the multiplier' : '✨ Add optional tax';
   const snapshot = async number => ({ number, title: title(number), state: merged.has(number) ? 'closed' : 'open',
     merged: merged.has(number), merge_commit_sha: merged.has(number) ? await branch('main') : null,
     user: { type: 'User', login: 'human' }, mergeable: number === 1 || !merged.has(1),
     head: { ref: 'feature-' + number, sha: await branch('feature-' + number), repo: { full_name: 'owner/repo' } },
     base: { ref: 'main', sha: await branch('main'), repo: { full_name: 'owner/repo' } } });
   const commit = async sha => ({ sha, author: { type: 'User', login: 'human' }, commit: { author,
     message: await git('--git-dir=' + remote, 'show', '-s', '--format=%B', sha) },
     parents: [{ sha: await git('--git-dir=' + remote, 'rev-parse', sha + '^') }] });
   const api = async (endpoint, method, fields) => {
     if (endpoint === 'repos/owner/repo') return { allow_rebase_merge: true, allow_squash_merge: true, default_branch: 'main' };
     if (endpoint.includes('/branches/')) return { protected: false, commit: { sha: await branch(endpoint.split('/').at(-1)) } };
     if (endpoint.includes('/check-runs?')) {
       const old = endpoint.includes(staleCheckHead);
       return { check_runs: [{ id: 1, name: 'price tests', status: 'completed', conclusion: old ? 'failure' : 'success' }] };
     }
     if (endpoint.includes('/check-suites?')) return { check_suites: [] };
     if (endpoint.includes('/status?')) return { statuses: [] };
     if (endpoint.includes('/pulls?')) return [];
     if (endpoint.includes('/commits?')) {
       const shas = (await git('--git-dir=' + remote, 'rev-list', '--reverse', 'main..feature-' + endpoint.split('/')[4])).split('\n');
       return Promise.all(shas.map(commit));
     }
     if (endpoint.includes('/commits/')) return commit(endpoint.split('/').at(-1));
     const number = Number(endpoint.split('/')[4]);
     if (endpoint.endsWith('/merge') && method === 'PUT') {
       const head = await branch('feature-' + number), base = await branch('main');
       assert(fields.includes('sha=' + head));
       assert(fields.includes('merge_method=squash'), 'Human-opened PRs prefer a native squash without rewriting');
       const message = fields.find(value => value.startsWith('commit_title=')).slice('commit_title='.length) + '\n\n' +
         fields.find(value => value.startsWith('commit_message=')).slice('commit_message='.length);
       assert(message.includes('Lindsey integration summary for https://github.com/owner/repo/pull/' + number));
       assert(message.includes('price tests: success'), 'The actual squash contains verified passing checks');
       const messageFile = path.join(root, 'native-squash-message');
       await fs.writeFile(messageFile, message);
       const squash = await git('--git-dir=' + remote, 'commit-tree', head + '^{tree}', '-p', base, '-F', messageFile);
       await git('--git-dir=' + remote, 'update-ref', 'refs/heads/main', squash, base);
       merged.add(number);
       return { merged: true, sha: squash };
     }
     if (number) return snapshot(number);
     throw Error('Unexpected endpoint ' + endpoint);
   };
   const localGit = async (...args) => { if (args[0] === 'clone') args[3] = remote; return git(...args); };
   const selection = { repository: 'owner/repo', pullRequests: [1, 2].map(number => ({ number,
     title: title(number), url: 'https://github.com/owner/repo/pull/' + number,
     head: 'feature-' + number, headSha: heads[number], base: 'main' })) };
   batch = await createMergeBatch(selection, { api, destination: 'https://chatgpt.com/',
     execute: (input, selected) => executeResolution(input, selected, { merge: (repository, number, options) =>
       humanSquashMerge(repository, number, { ...options, api, git: localGit, checkOptions: { timeoutMs: 0 },
         temporaryDirectory: () => fs.mkdtemp(path.join(root, 'executor-')) }) }) });
   const submit = async (url, number, patch = null) => {
     const launch = new URLSearchParams(new URL(url).hash.slice(1));
     const callback = launch.get('return_to');
     const response = await fetch(callback, { method: 'POST', headers: {
       Origin: new URL(callback).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({
       version: 1, repository: 'owner/repo', results: [{ number, headSha: heads[number], baseSha: await branch('main'),
         patch, ...(patch ? { decisions: [{ path: 'price.js', title: '🛠️ Retain multiplier three while adding tax',
           description: 'Main corrected the multiplier. Preserve that correction while adding the PR’s optional tax argument; do not restore multiplier two.' }] } : {}),
         explanation: number === 1 ? 'Correct the multiplier to three.' : 'Keep multiplier three and add optional tax.' }] }) });
     assert.equal(response.status, 200);
     return response.json();
   };
   const first = await submit(batch.url, 1);
   assert.equal(first.results[0].status, 'merged');
   assert.equal(await branch('feature-1'), heads[1], 'Native squash leaves the original PR branch unchanged');
   const conflict = await submit(first.continueUrl, 2);
   assert.equal(conflict.results[0].status, 'needs_resolution');
   assert.deepEqual(conflict.results[0].conflictPaths, ['price.js']);
   assert.equal(await branch('feature-2'), heads[2], 'A detected conflict does not push a partial tree');
   const patch = 'diff --git a/price.js b/price.js\n--- a/price.js\n+++ b/price.js\n@@ -1 +1 @@\n-function price(n) { return n * 3; }\n+function price(n, tax = 0) { return n * 3 + tax; }\n';
   const synced = await submit(conflict.continueUrl, 2, patch);
   assert.equal(synced.results[0].status, 'synced');
   assert.equal(await branch('main'), first.results[0].sha, 'Per-file preparation cannot modify main');
   assert.equal(await git('--git-dir=' + remote, 'rev-parse', synced.results[0].sha + '^^'), heads[2]);
   assert.equal(await git('--git-dir=' + remote, 'show', '-s', '--format=%s', synced.results[0].sha + '^'), '🛠️ Retain multiplier three while adding tax');
   assert.equal(await git('--git-dir=' + remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', synced.results[0].sha + '^'), 'price.js', 'Decision commit changes only its conflicted file');
   assert.equal(await git('--git-dir=' + remote, 'diff', '--name-only', synced.results[0].sha + '^', synced.results[0].sha), 'main-only.txt', 'The following sync includes only remaining incoming files');
   assert((await git('--git-dir=' + remote, 'show', '-s', '--format=%B', synced.results[0].sha + '^')).includes('do not restore multiplier two'));
   heads[2] = synced.results[0].sha;
   const final = await submit(synced.continueUrl, 2);
   assert.equal(final.results[0].status, 'merged', JSON.stringify(final));
   assert.equal(await branch('feature-2'), heads[2], 'Native squash retains the appended conflict decisions');
   assert.equal(final.batch.merged.length, 2);
   assert.deepEqual(final.batch.deferred, []);
   const code = await git('--git-dir=' + remote, 'show', 'main:price.js');
   const price = require('node:vm').runInNewContext(code + '; price;');
   assert.equal(price(2), 6); assert.equal(price(2, 1), 7);
   assert.equal(await git('--git-dir=' + remote, 'show', '-s', '--format=%an <%ae>', 'main'), 'John Wooten <human@example.test>');
   const message = await git('--git-dir=' + remote, 'show', '-s', '--format=%B', 'main');
   assert(message.startsWith(title(2) + ' (#2)\n'));
   assert(message.includes('Co-authored-by: Codex <noreply@openai.com>'));
   assert.equal(await repo('rev-parse', 'HEAD'), initial);
   assert.equal(await repo('status', '--porcelain'), '');
   assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('executor-')), []);
   console.log('Successive real Git merges preserve the earlier fix and later feature, tolerate old failed checks, and retain human attribution.');
 } finally { batch?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}
