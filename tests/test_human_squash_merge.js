'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { humanAuthor, verifiedHumanAuthor, verifyCommit, humanSquashMerge } = require('../efs/human_squash_merge');
const { squashMessage } = require('../efs/squash_attribution');

const baseSha = 'b'.repeat(40), oldHead = 'a'.repeat(40), newHead = 'c'.repeat(40);
const commits = [{
  author: { login: 'JFWooten4', type: 'User' },
  commit: {
    author: { name: 'John Wooten', email: 'noreply@wooten.link' },
    committer: { name: 'John Wooten', email: 'noreply@wooten.link' },
    message: '🐛 Fix first issue\n\nDetails.\n\nCo-authored-by: Codex <noreply@openai.com>'
  }
}, {
  author: { login: 'JFWooten4', type: 'User' },
  commit: {
    author: { name: 'John Wooten', email: 'noreply@wooten.link' },
    message: '🐛 Fix followup\n\nCo-authored-by: Codex Web <noreply@openai.com>'
  }
}];
const author = humanAuthor(commits);
const prepared = squashMessage('🐛 Fix placement', 12, commits, { primaryAuthor: author });
const message = prepared.title + '\n\n' + prepared.message;

async function main() {
  assert.deepEqual(author, { name: 'John Wooten', email: 'noreply@wooten.link' });
  assert.deepEqual(verifiedHumanAuthor(commits), { ...author, login: 'JFWooten4' });
  assert(!prepared.trailers.some(line => line.includes('John Wooten')),
    'Git author should not be duplicated as co-author');
  assert.deepEqual(prepared.trailers, [
    'Co-authored-by: Codex <noreply@openai.com>',
    'Co-authored-by: Codex Web <noreply@openai.com>'
  ]);
  assert.throws(() => humanAuthor([{ ...commits[0], author: { login: 'codex-pony[bot]', type: 'Bot' } }]),
    /verified original human/);
  assert.throws(() => humanAuthor([{ ...commits[0], author: null }]), /verified original human/);
  assert.throws(() => humanAuthor([{ author: { login: 'real', type: 'User' }, commit: {
    author: { name: 'codex-pony[bot]', email: 'bot@users.noreply.github.com' }
  } }]), /verified original human/);

  const resultCommit = {
    commit: { author, message }
  };
  verifyCommit(resultCommit, message, author);
  assert.throws(() => verifyCommit({ commit: { author: { name: 'codex-pony[bot]', email: author.email }, message } },
    message, author), /author/);
  assert.throws(() => verifyCommit({ commit: { author, message: message + '\nExtra' } },
    message, author), /message/);

  function harness({ protectedHead = false, dependent = false, rebase = true, changedBeforePush = false,
      noFiles = false, preparedPreviously = false, lateDependent = false, staleReads = 0, changedAfterPush = false, baseChangedAfterPush = false } = {}) {
    const apiCalls = [], gitCalls = [];
    let pushed = false, merged = false, dependencyChecks = 0, postPushReads = 0;
    const pr = () => ({
      state: merged ? 'closed' : 'open', draft: false, merged, mergeable: true,
      merged_at: merged ? '2026-10-21T00:00:00Z' : null,
      title: '🐛 Fix placement', number: 12,
      base: { ref: 'main', sha: baseSha, repo: { full_name: 'owner/repo' } },
      head: { ref: 'bot-topic', sha: pushed || changedBeforePush || preparedPreviously ? newHead : oldHead,
        repo: { full_name: 'owner/repo' } },
      merge_commit_sha: merged ? newHead : null
    });
    const api = async (endpoint, method = 'GET', fields = []) => {
      apiCalls.push({ endpoint, method, fields });
      if (endpoint === 'repos/owner/repo/pulls/12') {
        const snapshot = pr();
        if (pushed && !merged) {
          postPushReads++;
          if (postPushReads <= staleReads) snapshot.head.sha = oldHead;
          if (changedAfterPush) snapshot.head.sha = 'd'.repeat(40);
          if (baseChangedAfterPush) snapshot.base.sha = 'e'.repeat(40);
        }
        return snapshot;
      }
      if (endpoint === 'repos/owner/repo') return { allow_rebase_merge: rebase };
      if (endpoint.includes('/branches/')) return { protected: protectedHead };
      if (endpoint.includes('/pulls?state=')) return (dependent || (lateDependent && ++dependencyChecks >= 2)) ? [{ number: 13,
        base: { ref: 'bot-topic' }, head: { ref: 'downstream' } }] : [];
      if (endpoint.includes('/commits?per_page=')) return preparedPreviously
        ? [{ author: { login: 'JFWooten4', type: 'User' }, commit: { author, message } }]
        : commits;
      if (endpoint === 'repos/owner/repo/pulls/12/merge' && method === 'PUT') {
        assert.equal(pushed || preparedPreviously, true, 'Merge only after guarded push or an already prepared commit');
        assert.deepEqual(fields, ['-f', 'sha=' + newHead, '-f', 'merge_method=rebase']);
        merged = true;
        return { merged: true, sha: newHead };
      }
      if (endpoint === 'repos/owner/repo/commits/' + newHead) return resultCommit;
      throw new Error('Unexpected API endpoint: ' + endpoint);
    };
    const git = async (...args) => {
      gitCalls.push(args);
      if (args[0] === 'clone') {
        await fs.mkdir(path.join(args[4], '.git'), { recursive: true });
        return '';
      }
      assert.equal(args[0], '-C');
      const [command, ...rest] = args.slice(2);
      if (command === 'rev-parse') {
        switch (rest[0]) {
          case 'refs/remotes/origin/main': return baseSha;
          case 'refs/remotes/origin/bot-topic': return oldHead;
          case 'HEAD': return newHead;
          case baseSha + '^{tree}': return 'e'.repeat(40);
          case 'HEAD^{tree}': return 'f'.repeat(40);
        }
      }
      if (command === 'merge-base') return baseSha;
      if (command === 'diff') return noFiles ? '' : 'file.txt';
      if (command === 'commit') {
        assert(rest.includes('--author=John Wooten <noreply@wooten.link>'));
        assert(rest.includes('-F'));
        return '';
      }
      if (command === 'push') {
        assert(rest.includes('--force-with-lease=refs/heads/bot-topic:' + oldHead));
        assert(rest.includes(newHead + ':refs/heads/bot-topic'));
        pushed = true;
      }
      return '';
    };
    return { api, git, apiCalls, gitCalls, get pushed() { return pushed; }, get merged() { return merged; } };
  }
  const good = harness();
  const result = await humanSquashMerge('owner/repo', 12, { api: good.api, git: good.git });
  assert.equal(result.merged, true);
  assert.equal(result.sha, newHead);
  assert.deepEqual(result.author, author);
  assert(good.gitCalls.some(args => args.includes('commit')), 'Explicit git commit is required');
  assert(good.gitCalls.some(args => args.includes('push')), 'Guarded PR branch push required');
  assert(!good.gitCalls.some(args => args.includes('refs/heads/main') && args.includes('push')),
    'Never push to main');

  const stale = harness({ staleReads: 2 });
  const waits = [];
  assert.equal((await humanSquashMerge('owner/repo', 12,
    { api: stale.api, git: stale.git, wait: async ms => waits.push(ms) })).merged, true);
  assert.equal(waits.length, 2, 'Wait for GitHub to expose the prepared head');
  assert.equal(stale.gitCalls.filter(args => args.includes('push')).length, 1,
    'Stale API responses must never trigger another force push');
  const neverRefreshed = harness({ staleReads: 100 });
  const timeoutWaits = [];
  await assert.rejects(humanSquashMerge('owner/repo', 12, {
    api: neverRefreshed.api, git: neverRefreshed.git, wait: async ms => timeoutWaits.push(ms)
  }), /not refreshed.*retry Squash and merge/);
  assert.equal(timeoutWaits.length, 5, 'Stale responses have a bounded retry');
  assert.equal(neverRefreshed.merged, false);
  for (const options of [{ changedAfterPush: true }, { baseChangedAfterPush: true }]) {
    const raced = harness(options);
    await assert.rejects(humanSquashMerge('owner/repo', 12, {
      api: raced.api, git: raced.git, wait: async () => assert.fail('Actual changes must stop immediately')
    }), /PR changed after guarded push/);
    assert.equal(raced.merged, false);
  }

  // A failed review/check can leave the prepared PR open. A retry must NOT
  // force-push the same branch and restart checks again.
  const retry = harness({ preparedPreviously: true });
  const retried = await humanSquashMerge('owner/repo', 12, { api: retry.api, git: retry.git });
  assert.equal(retried.merged, true);
  assert.equal(retry.gitCalls.length, 0, 'Existing human-authored squash must merge without a new checkout or rewrite');
  assert.equal(retry.pushed, false);
  for (const [options, pattern] of [
    [{ protectedHead: true }, /protected/],
    [{ dependent: true }, /depends on or shares/],
    [{ lateDependent: true }, /depends on or shares/],
    [{ rebase: false }, /rebase merging is disabled/],
    [{ noFiles: true }, /no changes/]
  ]) {
    const denied = harness(options);
    await assert.rejects(humanSquashMerge('owner/repo', 12,
      { api: denied.api, git: denied.git }), pattern);
    assert.equal(denied.pushed, false, 'Guard failures must leave the PR head untouched');
  }
  const changed = harness({ changedBeforePush: true });
  await assert.rejects(humanSquashMerge('owner/repo', 12, { api: changed.api, git: changed.git }),
    /Selected base or head changed|PR changed/);
  assert.equal(changed.pushed, false);
  assert.equal(changed.merged, false);
  await assert.rejects(humanSquashMerge('bad', 12, { api: good.api, git: good.git }), /Invalid/);
  console.log('Human-authored GitHub merge checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
