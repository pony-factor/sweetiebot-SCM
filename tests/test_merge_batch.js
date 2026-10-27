'use strict';
const assert = require('node:assert/strict');
const { createMergeBatch } = require('../efs/merge_batch');
const { readMergeChecks, waitForMergeChecks } = require('../efs/merge_checks');
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40);
const selection = { repository: 'owner/repo', pullRequests: [1, 2].map(number => ({ number,
  title: 'Feature ' + number, url: 'https://github.com/owner/repo/pull/' + number,
  head: 'feature-' + number, headSha: number === 1 ? a : b, base: 'main' })) };

async function submit(url, results, deferred) {
  const target = new URL(url);
  const launch = new URLSearchParams(target.hash.slice(1));
  const callback = launch.get('return_to') || url;
  const response = await fetch(callback, { method: 'POST',
    headers: { Origin: new URL(callback).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, repository: 'owner/repo', results, ...(deferred ? { deferred } : {}) }) });
  return { status: response.status, value: await response.json() };
}
const item = (number, baseSha, patch = null, headSha = number === 1 ? a : b) => ({ number,
  headSha, baseSha, patch, explanation: number === 1 ? 'Preserve the main calculation fix.' : 'Add the optional feature without undoing the calculation fix.' });

(async () => {
  let base = c, calls = 0, secondAttempt = 0;
  const prs = new Map(selection.pullRequests.map(pr => [pr.number, { ...pr }]));
  const api = async endpoint => {
    if (endpoint.includes('/branches/')) return { commit: { sha: base } };
    const number = Number(endpoint.split('/').at(-1)), pr = prs.get(number);
    assert(pr);
    return { number, state: 'open', draft: false, title: pr.title,
      mergeable: number !== 2 || base === c, head: { ref: pr.head, sha: pr.headSha, repo: { full_name: 'owner/repo' } },
      base: { ref: pr.base } };
  };
  const batch = await createMergeBatch(selection, { api, destination: 'https://chatgpt.com/', execute: async input => {
    calls++;
    const selected = input.results[0];
    if (!selected) return { repository: 'owner/repo', results: [] };
    if (selected.number === 1) { base = d; return { repository: 'owner/repo', results: [{ number: 1,
      status: 'merged', merged: true, sha: d, headSha: a, previousHeadSha: a }] }; }
    secondAttempt++;
    assert.equal(selected.baseSha, d, 'Later work uses the base that actually merged');
    return { repository: 'owner/repo', results: [{ number: 2, merged: secondAttempt > 1,
      status: secondAttempt === 1 ? 'needs_resolution' : 'merged', sha: e,
      conflictPaths: secondAttempt === 1 ? ['price.js'] : [], baseSha: d }] };
  } });
  try {
    assert(batch.instructions.includes('INTELLIGENT MERGE ORDER'));
    assert.equal(batch.state().activities[1].phase, 'reviewing');
    assert.match(batch.state().activities[1].message, /waiting for GPT/);
    const tooMany = await submit(batch.url, [item(1, c), item(2, c)]);
    assert.equal(tooMany.status, 400);
    assert.equal(calls, 0, 'Do not prepare stale multi-PR patches in one round');
    const first = await submit(batch.url, [item(1, c)]);
    assert.equal(first.value.batch.merged.length, 1);
    assert.equal(first.value.batch.activities[1].phase, 'merged');
    assert.equal(first.value.batch.activities[2].phase, 'reviewing');
    let prompt = new URLSearchParams(new URL(first.value.continueUrl).hash.slice(1)).get('q');
    assert(prompt.includes('Preserve the main calculation fix.'));
    assert(prompt.includes('GITHUB REVIEW PUBLICATION POLICY'));
    assert(prompt.includes('publish zero inline comments'));
    assert(prompt.includes('decision commit titles/bodies'));
    assert(prompt.includes('sweetiebot-merge-options'), 'Automatic rounds reuse the existing selectable recommendation format');
    assert(prompt.includes('Before deferring a PR for human review'));
    assert(prompt.includes('multiple plausible resolutions have materially different behavior'));
    assert(prompt.includes('"baseAdvancedByEarlierWork":true'));
    assert(prompt.includes('"initiallyMergeable":true'));
    const conflict = await submit(first.value.continueUrl, [item(2, d)]);
    prompt = new URLSearchParams(new URL(conflict.value.continueUrl).hash.slice(1)).get('q');
    assert(prompt.includes('price.js'));
    assert(prompt.includes('needs_resolution'));
    assert.equal(conflict.value.batch.deferred.length, 0, 'A routine overlap does not request human input');
    const resolved = await submit(conflict.value.continueUrl, [item(2, d, 'complete current-base patch\n')]);
    assert.equal(resolved.value.batch.merged.length, 2);
    assert.equal(resolved.value.continueUrl, undefined);
    await submit(batch.url, [item(1, c)]);
    assert.equal(calls, 3, 'Replaying an earlier round cannot execute it twice');
  } finally { batch.dispose(); }

  let repairAttempts=0;
  const repairSelection={...selection,pullRequests:[selection.pullRequests[0]]};
  const repair=await createMergeBatch(repairSelection,{api,destination:'https://chatgpt.com/',branchOnly:true,
    execute:async body=>{
      assert.equal(body.results[0].operation,'sync');repairAttempts++;
      return {repository:selection.repository,results:[{number:1,status:repairAttempts===1?'needs_resolution':'synced',
        merged:false,sha:a,previousHeadSha:a,conflictPaths:repairAttempts===1?['options.html']:[]}]};
    }});
  try {
    const forbidden=await submit(repair.url,[{...item(1,c),operation:'merge'}]);
    assert.equal(forbidden.status,400);assert.equal(repairAttempts,0);
    const first=await submit(repair.url,[{...item(1,c),operation:'sync'}]);
    assert(first.value.continueUrl,'Manual PR repair automatically continues after discovering conflicts');
    const prompt=new URLSearchParams(new URL(first.value.continueUrl).hash.slice(1)).get('q');
    assert(prompt.includes('BRANCH-ONLY EXECUTION'));
    assert(prompt.includes('options.html'));
    const second=await submit(first.value.continueUrl,[{...item(1,c,'complete patch\n'),operation:'sync'}]);
    assert.equal(second.value.batch.prepared.length,1);
    assert.equal(second.value.batch.merged.length,0,'A branch fix never claims a merge');
    assert.equal(second.value.continueUrl,undefined,'Successful synchronization finishes the repair loop');
  } finally {repair.dispose();}

  // GitHub retargets children to the merged parent's destination when its
  // branch is deleted. Unrelated base changes still require a fresh selection.
  for (const [retarget, headChanged] of [['main', false], ['unrelated', false], ['main', true]]) {
    let parentMerged = false;
    const stack = { ...selection, pullRequests: selection.pullRequests.map(pr =>
      pr.number === 2 ? { ...pr, base: 'feature-1' } : pr) };
    const stacked = await createMergeBatch(stack, {
      destination: 'https://chatgpt.com/',
      api: async endpoint => {
        if (endpoint.includes('/branches/')) return { commit: { sha: parentMerged ? d : c } };
        const pr = stack.pullRequests.find(pr => endpoint.endsWith('/' + pr.number));
        return { state: 'open', draft: false, title: pr.title,
          head: { ref: pr.head, sha: pr.number === 2 && parentMerged && headChanged ? e : pr.headSha,
            repo: { full_name: stack.repository } },
          base: { ref: pr.number === 2 && parentMerged ? retarget : pr.base } };
      },
      execute: async (input, snapshot) => {
        const number = input.results[0].number;
        if (number === 2) assert.equal(snapshot.pullRequests[0].base, 'main');
        parentMerged = true;
        return { repository: stack.repository, results: [{ number, status: 'merged', merged: true, sha: d }] };
      }
    });
    try {
      const premature = await submit(stacked.url, [item(2, c)]);
      assert.equal(premature.status, 400, 'A selected child cannot merge before its ancestor');
      assert.equal(parentMerged, false, 'Dependency rejection performs no local execution');
      const first = await submit(stacked.url, [item(1, c)]);
      if (retarget === 'main' && !headChanged) {
        assert.equal(first.value.batch.pullRequests.find(pr => pr.number === 2).base, 'main');
        assert.deepEqual(first.value.batch.deferred, []);
        const second = await submit(first.value.continueUrl, [item(2, d)]);
        assert.equal(second.value.batch.merged.length, 2);
      } else {
        assert.equal(first.value.continueUrl, undefined);
        assert.equal(first.value.batch.deferred[0].number, 2);
      }
    } finally { stacked.dispose(); }
  }

  // A prepared head is accepted only as a result of our own local executor.
  const one = { ...selection, pullRequests: [selection.pullRequests[0]] };
  let currentHead = a, attempts = 0;
  const ownApi = async endpoint => endpoint.includes('/branches/') ? { commit: { sha: c } } : {
    state: 'open', draft: false, title: 'Feature 1', head: { ref: 'feature-1', sha: currentHead,
      repo: { full_name: 'owner/repo' } }, base: { ref: 'main' } };
  const own = await createMergeBatch(one, { api: ownApi, destination: 'https://chatgpt.com/', execute: async () => {
    attempts++; currentHead = e;
    return { repository: 'owner/repo', results: [{ number: 1, status: attempts === 1 ? 'waiting' : 'merged',
      merged: attempts > 1, sha: e, previousHeadSha: attempts === 1 ? a : e }] };
  } });
  try {
    const prepared = await submit(own.url, [item(1, c)]);
    assert(prepared.value.continueUrl);
    const finished = await submit(prepared.value.continueUrl, [item(1, c, null, e)]);
    assert.equal(finished.value.batch.merged.length, 1);
  } finally { own.dispose(); }

  // Unchanged branch-only results must stop rather than repeatedly retrying.
  // Dashboard polling can recover a repaired head without executing an old
  // patch, accepting rewritten history, or retrying a human decision.
  for (const mode of ['repaired', 'rewritten', 'retitled', 'human', 'running']) {
    let liveHead = a, applied = 0, title = 'Feature 1', release;
    const gate = new Promise(resolve => { release = resolve; });
    const recovery = await createMergeBatch(one, {
      destination: 'https://chatgpt.com/',
      api: async endpoint => {
        if (endpoint.includes('/compare/')) return { status: mode === 'rewritten' ? 'diverged' : 'ahead', merge_base_commit: { sha: a } };
        if (endpoint.includes('/branches/')) return { commit: { sha: c } };
        return { state: 'open', draft: false, title, mergeable: true,
          head: { ref: 'feature-1', sha: liveHead, repo: { full_name: one.repository } }, base: { ref: 'main' } };
      },
      execute: async () => {
        applied++;
        if (mode === 'running') await gate;
        return { repository: one.repository, results: [{ number: 1, status: applied === 1 ? 'blocked' : 'merged',
          merged: applied > 1, sha: e, reason: 'Selected PR head, base or title changed; prepare a fresh handoff.' }] };
      }
    });
    try {
      let pending;
      if (mode === 'human') await submit(recovery.url, [], [{ number: 1, headSha: a, kind: 'human_review', reason: 'Choose incompatible API behavior.' }]);
      else if (mode === 'running') {
        pending = submit(recovery.url, [item(1, c)]);
        while (!applied) await new Promise(resolve => setImmediate(resolve));
      } else await submit(recovery.url, [item(1, c)]);
      liveHead = e;
      if (mode === 'retitled') title = 'Different scope';
      const next = await recovery.reconcile([1]);
      if (mode === 'running') { assert.equal(next, null); release(); await pending; }
      else if (mode !== 'repaired') {
        assert.equal(next, null);
        assert.equal(recovery.state().pullRequests[0].headSha, a);
      } else {
        assert(next.url, 'A repaired deferred PR receives a fresh review');
        assert.equal(recovery.state().deferred.length, 0);
        assert.equal(recovery.state().pullRequests[0].headSha, e);
        assert.equal(await recovery.reconcile([1]), null, 'Polling the same repaired head cannot launch duplicate work');
        const old = await fetch(new URLSearchParams(new URL(recovery.url).hash.slice(1)).get('return_to')).catch(() => null);
        assert.equal(old, null, 'The stale patch endpoint is retired');
        const done = await submit(next.url, [item(1, c, null, e)]);
        assert.equal(done.value.batch.merged.length, 1);
        assert.equal(applied, 2, 'Only the fresh reviewed handoff reaches execution');
      }
    } finally { release(); recovery.dispose(); }
  }

  currentHead = a;
  const noOp = await createMergeBatch(one, { api: ownApi, destination: 'https://chatgpt.com/',
    execute: async () => ({ repository: 'owner/repo', results: [{
      number: 1, status: 'synced', merged: false, unchanged: true, sha: a, previousHeadSha: a,
      reason: 'No merge conflicts; branch left unchanged.'
    }] }) });
  try {
    const unchanged = await submit(noOp.url, [item(1, c)]);
    assert.equal(unchanged.value.batch.merged.length, 0);
    assert.equal(unchanged.value.batch.deferred.length, 1);
    assert.equal(unchanged.value.continueUrl, undefined, 'No-op sync must not trigger another round');
  } finally { noOp.dispose(); }

  // A fresh failing head gets one bounded AI repair round, never a merge bypass.
  currentHead = a; attempts = 0;
  const failing = await createMergeBatch(one, { api: ownApi, destination: 'https://chatgpt.com/', execute: async () => {
    attempts++; currentHead = e;
    return { repository: 'owner/repo', results: [{ number: 1, status: 'checks_failed',
      merged: false, sha: e, previousHeadSha: attempts === 1 ? a : e,
      reason: 'GitHub pull requests: missing warning preference in test harness' }] };
  } });
  try {
    const failed = await submit(failing.url, [item(1, c)]);
    assert.equal(failed.value.batch.deferred.length, 0);
    assert(failed.value.continueUrl, 'Give AI the actual failure before stopping');
    const prompt = new URLSearchParams(new URL(failed.value.continueUrl).hash.slice(1)).get('q');
    assert(prompt.includes('inspect the actual failing job logs'));
    assert(prompt.includes('missing warning preference in test harness'));
    const exhausted = await submit(failed.value.continueUrl, [item(1, c, 'complete repaired patch\n', e)]);
    assert.equal(exhausted.value.batch.deferred.length, 1);
    assert.equal(exhausted.value.batch.merged.length, 0);
    assert.equal(exhausted.value.continueUrl, undefined, 'Repeated failures stop without bypassing CI');
  } finally { failing.dispose(); }

  // Main may advance during preparation. Retry and adopt only our verified
  // prepared head, including when its first result is a base-refresh request.
  currentHead = a; attempts = 0;
  const raced = await createMergeBatch(one, { api: ownApi, destination: 'https://chatgpt.com/',
    onResult: async () => { throw Error('Dashboard closed'); }, execute: async () => {
      attempts++; currentHead = e;
      return { repository: 'owner/repo', results: [{ number: 1, status: attempts < 3 ? 'needs_refresh' : 'merged',
        merged: attempts === 3, sha: e, previousHeadSha: attempts === 1 ? a : e }] };
    } });
  try {
    const first = await submit(raced.url, [item(1, c)]);
    const second = await submit(first.value.continueUrl, [item(1, c, null, e)]);
    const third = await submit(second.value.continueUrl, [item(1, c, null, e)]);
    assert.equal(third.value.batch.merged.length, 1);
    assert.deepEqual(third.value.batch.deferred, [], 'A successful last retry is not also a blocker');
  } finally { raced.dispose(); }

  const page = require('node:fs').readFileSync(require.resolve('../efs/merge_handoff.html'), 'utf8');
  const pageScript = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const next = 'https://chatgpt.com/#sweetiebot_merge=1&q=Refreshed%20round';
  for (const destination of [next, 'https://example.com/#sweetiebot_merge=1']) {
    const elements = { status: {}, results: {after(){}} }, navigations = [];
    await require('node:vm').runInNewContext(pageScript, { URL, URLSearchParams,
      location: { hash: '#result=' + encodeURIComponent('{}'), pathname: '/lindsey-merge/fixture', assign: url => navigations.push(url) },
      history: { replaceState() {} }, document: { getElementById: id => elements[id], createElement:()=>({}) },
      setInterval: () => 1, clearInterval() {}, fetch: async () => ({ ok: true, json: async () => ({
        results: [], batch: { merged: [1], deferred: [] }, continueUrl: destination }) }) });
    assert.deepEqual(navigations, destination === next ? [next] : [], 'Only a verified ChatGPT merge continuation is followed');
  }

  let checks = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
    check_suites: [], statuses: [] };
  const checkApi = async endpoint => endpoint.includes('/check-runs?') ? { check_runs: checks.check_runs }
    : endpoint.includes('/check-suites?') ? { check_suites: checks.check_suites } : { statuses: checks.statuses };
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'failed');
  checks.check_runs.push({ id: 2, name: 'test', status: 'completed', conclusion: 'success' });
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'passed', 'A successful rerun supersedes an old failure');
  checks.check_runs = [];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a, { expectChecks: true })).state, 'pending');
  assert.equal((await waitForMergeChecks(checkApi, 'owner/repo', a, { expectChecks: true, timeoutMs: 0 })).state, 'pending');
  checks.check_suites = ['Netlify', 'AWS Amplify'].map(name => ({
    app: { name }, status: 'queued', latest_check_runs_count: 0
  }));
  assert.deepEqual(await readMergeChecks(checkApi, 'owner/repo', a),
    { state: 'passed', names: [], hasChecks: false },
    'Empty app suites must not delay ready PRs or create a check expectation after squash');
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a, { expectChecks: true })).state,
    'pending', 'Empty suites do not satisfy checks expected from the original head');
  await waitForMergeChecks(checkApi, 'owner/repo', a, {
    sleep: async () => assert.fail('Empty queued suites must not start a polling wait')
  });
  checks.check_runs = [{ name: 'test', status: 'queued' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending');
  checks.check_runs = [];
  checks.check_suites = [{ status: 'queued', latest_check_runs_count: 1 }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending',
    'A queued suite with jobs still blocks');
  checks.check_suites = [{ status: 'queued' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending',
    'An unknown job count is not evidence of an empty suite');
  checks.statuses = [{ context: 'required', state: 'pending' }];
  checks.check_suites = [{ status: 'queued', latest_check_runs_count: 0 }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending',
    'Actual pending statuses still block alongside empty suites');
  checks.statuses = [];
  checks.check_runs = [{ name: 'test', status: 'queued' }];
  checks.check_runs[0] = { name: 'test', status: 'completed', conclusion: 'success' };
  checks.check_suites = [{ status: 'in_progress' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending', 'Wait for the full suite, not only its first finished job');
  checks.check_suites = [{ status: 'completed', conclusion: 'failure' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'failed', 'A failed suite cannot pass just because its jobs are absent');
  checks.check_runs = [{ id: 1, name: 'test', check_suite: { id: 10 }, status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'test', check_suite: { id: 11 }, status: 'completed', conclusion: 'success' }];
  checks.check_suites = [{ id: 10, status: 'completed', conclusion: 'failure' },
    { id: 11, status: 'completed', conclusion: 'success' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'passed', 'An old suite failure does not override a successful job rerun');
  console.log('Sequential merge continuation, intent ledger, current-base resolution, replay and integrated-head check gates passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
