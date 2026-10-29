'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { humanAuthor, verifiedHumanAuthor, verifyCommit, humanSquashMerge } = require('../extension/merge/human_squash_merge');

const oldSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergedSha = 'c'.repeat(40);
const originalAuthor = { name: 'John Wooten', email: 'noreply@wooten.link' };
const originalMessage = '🐛 Fix placement (#12)\n\n- 🐛 Fix placement\n\n__________\n\nCo-authored-by: Codex Web <noreply@openai.com>';
const oneHuman = {
  sha: oldSha, author: { login: 'JFWooten4', type: 'User' },
  commit: { author: originalAuthor, message: originalMessage }
};
const secondHuman = { ...oneHuman, sha: 'd'.repeat(40) };
const basePR = () => ({
  state: 'open', draft: false, merged_at: null, merged: false, mergeable: true,
  title: '🐛 Fix placement', number: 12, stack: null,
  base: { ref: 'main', sha: baseSha, repo: { full_name: 'owner/repo' } },
  head: { ref: 'bot-topic', sha: oldSha, repo: { full_name: 'owner/repo' } }
});

function fixture({ commits = [oneHuman], pr = basePR(), rebase = true,
  changedBeforeMerge = false, changedTitleBeforeMerge = false, incorrectResultAuthor = false,
  liveBaseSha = baseSha, changedBaseBeforeMerge = false, refreshedBaseSha,
  mergedMessage = originalMessage } = {}) {
  const calls = [];
  let merged = false;
  const api = async (endpoint, method = 'GET', fields = []) => {
    calls.push({ endpoint, method, fields });
    if (endpoint === 'repos/owner/repo/pulls/12') {
      if (merged) return { ...pr, state: 'closed', merged: true,
        merged_at: '2026-10-22T00:00:00Z', merge_commit_sha: mergedSha };
      if (changedBeforeMerge && calls.filter(x => x.endpoint === endpoint).length > 1)
        return { ...pr, head: { ...pr.head, sha: 'e'.repeat(40) } };
      if (changedTitleBeforeMerge && calls.filter(x => x.endpoint === endpoint).length > 1)
        return { ...pr, title: '🐛 Renamed placement fix' };
      return refreshedBaseSha && calls.filter(x => x.endpoint === endpoint).length > 1
        ? { ...pr, base: { ...pr.base, sha: refreshedBaseSha } } : pr;
    }
    if (endpoint === 'repos/owner/repo/branches/main') {
      const reads = calls.filter(x => x.endpoint === endpoint).length;
      return { commit: { sha: changedBaseBeforeMerge && reads > 1 ? 'f'.repeat(40) : liveBaseSha } };
    }
    if (endpoint.includes('/commits?per_page=')) return commits;
    if (endpoint === 'repos/owner/repo') return { allow_rebase_merge: rebase };
    if (endpoint === 'repos/owner/repo/pulls/12/merge' && method === 'PUT') {
      assert.deepEqual(fields, ['-f', 'sha=' + oldSha, '-f', 'merge_method=rebase']);
      merged = true;
      return { merged: true, sha: mergedSha };
    }
    if (endpoint === 'repos/owner/repo/commits/' + mergedSha) return {
      commit: { author: incorrectResultAuthor ? { name: 'codex-pony[bot]', email: 'bot@example.org' }
        : originalAuthor, message: mergedMessage }
    };
    throw Error('Unexpected API call: ' + endpoint);
  };
  return { api, calls, get merged() { return merged; } };
}

async function main() {
  assert.deepEqual(humanAuthor([oneHuman]), originalAuthor);
  assert.deepEqual(verifiedHumanAuthor([oneHuman]), { ...originalAuthor, login: 'JFWooten4' });
  assert.throws(() => humanAuthor([{...oneHuman,author:{login:'codex-pony[bot]',type:'Bot'}}]),
    /No verified original human/);
  assert.throws(() => humanAuthor([{...oneHuman,author:null}]), /No verified original human/);
  verifyCommit({ commit: { author: originalAuthor, message: originalMessage } },
    originalMessage, originalAuthor);
  assert.throws(() => verifyCommit({commit: { author:{name:'codex-pony[bot]',email:'bot@example.org'},
    message:originalMessage }}, originalMessage, originalAuthor), /author/);

  const source = readFileSync(path.join(__dirname, '../extension/merge/human_squash_merge.js'), 'utf8');
  assert(!source.includes('--force-with-lease'));
  assert(!source.includes('git(\'push\''));
  assert(!source.includes('inRepo(\'push\''));

  const approved = fixture();
  const git = async () => assert.fail('No local git write or push is allowed');
  const result = await humanSquashMerge('owner/repo', 12, {api: approved.api, git});
  assert(result.merged && result.sha === mergedSha);
  assert.deepEqual(result.author, originalAuthor);
  assert.equal(approved.calls.filter(c => c.method === 'PUT').length, 1);
  // A stale PR base, including a later metadata refresh, must not block a stable branch.
  const stale = fixture({ liveBaseSha: 'd'.repeat(40), refreshedBaseSha: 'd'.repeat(40) });
  assert((await humanSquashMerge('owner/repo', 12, {api: stale.api})).merged);
  const many = fixture({ commits: [oneHuman, secondHuman] });
  await assert.rejects(humanSquashMerge('owner/repo', 12, {api:many.api, git}),
    /No-force-push policy: cannot squash multiple original PR commits/);
  assert(!many.merged);
  assert(!many.calls.some(c => c.method !== 'GET'));
  const guarded = fixture({ commits: [oneHuman, secondHuman] });
  let delegated = 0;
  const localMerge = async (repo, number, options) => {
    delegated++;
    assert.equal(repo, 'owner/repo');
    assert.equal(number, 12);
    assert.equal(options.api, guarded.api);
    assert.equal(options.allowHistoryRewrite, true);
    assert.equal(options.rewriteReason, 'preserve-human-author');
    assert.deepEqual(options.expected, { headSha: oldSha, baseSha, head: 'bot-topic',
      base: 'main', title: '🐛 Fix placement' });
    return { merged: true, sha: mergedSha };
  };
  assert((await humanSquashMerge('owner/repo', 12, {
    api: guarded.api, allowHistoryRewrite: true, localMerge
  })).merged);
  assert.equal(delegated, 1);
  assert(!guarded.calls.some(c => c.method !== 'GET'), 'Only the guarded local executor may write');
  const unprepared = fixture({ commits: [{ ...oneHuman, commit: { ...oneHuman.commit, message: 'Original title' } }] });
  assert.equal((await humanSquashMerge('owner/repo', 12, {
    api: unprepared.api, allowHistoryRewrite: true,
    localMerge: async () => ({ merged: false, status: 'waiting', reason: 'Waiting for required checks' })
  })).status, 'waiting');
  const prepared = fixture();
  assert((await humanSquashMerge('owner/repo', 12, {
    api: prepared.api, allowHistoryRewrite: true,
    localMerge: async () => assert.fail('Prepared one-commit PR must not be rewritten')
  })).merged);
  for (const name of ['Codex (Web)', 'Codex (6.1 Med, Web)']) {
    const mergedMessage = originalMessage.replace('Codex Web', name);
    const updated = fixture({mergedMessage, commits:[{...oneHuman,commit:{...oneHuman.commit,
      message:mergedMessage}}]});
    assert((await humanSquashMerge('owner/repo', 12, {
      api:updated.api, allowHistoryRewrite:true,
      localMerge:async()=>assert.fail('Prepared model/Web credit must not be rewritten')
    })).merged, name + ' must be accepted as valid Codex web credit');
  }

  for (const [style,divider] of [['hyphens','---------'],['none','']]) {
    const differentMessage = originalMessage.replace('\n\n__________\n\n',
      divider ? '\n\n'+divider+'\n\n' : '\n\n');
    const selected = fixture({
      commits:[{...oneHuman,commit:{...oneHuman.commit,message:differentMessage}}],
      mergedMessage:differentMessage
    });
    assert((await humanSquashMerge('owner/repo',12,
      {api:selected.api,trailerSeparatorStyle:style})).merged);
    const mismatch = fixture();
    await assert.rejects(humanSquashMerge('owner/repo',12,
      {api:mismatch.api,trailerSeparatorStyle:style}),/configured co-author separator/);
    assert(!mismatch.calls.some(c=>c.method!=='GET'));
  }
  for (const change of [
    [{ ...oneHuman, commit: { ...oneHuman.commit,
      message: originalMessage.replace('__________', '---------') } }, /configured co-author separator/],
    [{ ...oneHuman, commit: { ...oneHuman.commit, message: 'Different title' } }, /exact PR title/],
    [{ ...oneHuman, commit: { ...oneHuman.commit, message: '🐛 Fix placement (#12)' } }, /required Codex Web credit/],
    [{ ...oneHuman, author: { login: 'codex-pony[bot]', type:'Bot' } }, /No verified original human/],
    [{ ...oneHuman, sha: 'f'.repeat(40) }, /head does not match/]
  ]) {
    const blocked = fixture({ commits: [change[0]] });
    await assert.rejects(humanSquashMerge('owner/repo', 12, {api:blocked.api,git}), change[1]);
    assert(!blocked.calls.some(c => c.method !== 'GET'));
  }
  for (const [options, pattern] of [
    [{pr:{...basePR(),state:'closed'}}, /open, mergeable/],
    [{pr:{...basePR(),draft:true}}, /open, mergeable/],
    [{rebase:false}, /rebase merging is disabled/],
    [{changedBeforeMerge:true}, /head or base changed/],
    [{changedBaseBeforeMerge:true}, /head or base changed/],
    [{liveBaseSha:'invalid'}, /Cannot verify/],
    [{changedTitleBeforeMerge:true}, /head or base changed/]
  ]) {
    const blocked = fixture(options);
    await assert.rejects(humanSquashMerge('owner/repo',12,{api:blocked.api,git}),pattern);
    assert(!blocked.calls.some(c => c.method !== 'GET'));
  }
  const local = fixture({commits:[secondHuman,oneHuman]});
  let localOptions;
  const localResult=await humanSquashMerge('owner/repo',12,{api:local.api,localGitMerge:true,
    localMerge:async(repo,number,options)=>{assert.equal(repo,'owner/repo');assert.equal(number,12);localOptions=options;return {merged:true,sha:mergedSha};}});
  assert(localResult.merged);
  assert.equal(localOptions.localGitMerge,true);
  assert.equal(localOptions.allowHistoryRewrite,false);
  assert.equal(localOptions.expected.headSha,oldSha);
  assert(!local.calls.some(call=>call.method!=='GET'),'Sidebar handoff never attempts a native bot-authored squash');
  const mismatch = fixture({incorrectResultAuthor:true});
  await assert.rejects(humanSquashMerge('owner/repo',12,{api:mismatch.api,git}), /author/);
  await assert.rejects(humanSquashMerge('bad',12,{api:approved.api}), /Invalid/);
  console.log('Non-rewriting human-authored merge checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
