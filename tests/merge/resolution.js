'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { validateResolution, validateSyncResolution, executeResolution, invokeResolutionCLI, resolutionInstructions, MAX_PATCH_BYTES } = require('../../extension/merge/resolution');
const { createMergeHandoff } = require('../../extension/merge/handoff');
const { patchPaths, safePatchPath } = require('../../extension/merge/patch');
const { validateResolutionHunks, applyResolutionHunks } = require('../../extension/merge/conflict-hunks');
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const { reviewPublicationInstructions } = require('../../extension/merge/review-policy');
const { blockerPrompt } = require('../../extension/merge/blocker-actions');
const { assistantCoauthorTrailer } = require('../../extension/merge/resolution-commits');
assert(reviewPublicationInstructions().includes('Never create a per-file inline comment'));
assert(reviewPublicationInstructions().includes('Only tag truly actionable findings'));
const selection = { repository: 'owner/repo', pullRequests: [{ number: 12,
  title: 'Fix a conflict', head: 'feature', base: 'main', headSha: head,
  url: 'https://github.com/owner/repo/pull/12' }] };
const input = { version: 1, repository: 'owner/repo', results: [{
  number: 12, headSha: head, baseSha: base, patch: null, explanation: 'Preserve the human Git author.'
}] };

const webPrompt = blockerPrompt(selection.repository, selection.pullRequests[0],
  { id: 'resolve-conflicts', label: 'Resolve conflicts', prompt: 'Preserve both.', manual: true }, 'web');
assert(webPrompt.includes('Co-authored-by: ChatGPT MODEL <noreply@openai.com>'));
assert(webPrompt.includes('replacing MODEL with that actual version number'));
assert(!webPrompt.includes('Co-authored-by: ChatGPT 6 <noreply@openai.com>'));
assert.equal(assistantCoauthorTrailer('6.1'), 'Co-authored-by: ChatGPT 6.1 <noreply@openai.com>');
assert.equal(assistantCoauthorTrailer('7.2'), 'Co-authored-by: ChatGPT 7.2 <noreply@openai.com>');
assert.equal(assistantCoauthorTrailer(undefined), '');
for (const invalid of ['Codex Web', 'GPT-6', '6 Med', '6\nOther', '', null, 6])
  assert.throws(() => assistantCoauthorTrailer(invalid), /Invalid current web coding model number/);
assert(!webPrompt.includes('Co-authored-by: Codex Web <noreply@openai.com>'));
const handoffPolicy = resolutionInstructions(selection, 'http://127.0.0.1:12345/return');
assert(handoffPolicy.includes('GITHUB REVIEW PUBLICATION POLICY'));
assert(handoffPolicy.includes('publish zero inline comments'));
assert(handoffPolicy.includes('local handoff record'));
assert(handoffPolicy.includes('AUTOMATIC LINDSEY REVIEW'));
assert(handoffPolicy.includes('Resolve clear behavior-preserving integrations automatically'));
assert(handoffPolicy.includes('sweetiebot-merge-options'), 'Genuine choices are published during the initial Lindsey conflict review');
assert(handoffPolicy.includes('NO-OP SYNCHRONIZATION'));
assert(!handoffPolicy.includes('If gzip output still exceeds the URL budget, stop'),'Oversized results use a safe alternate transport');
assert(handoffPolicy.includes('mandatory final result'),'Apply with Lindsey is mandatory');
assert(handoffPolicy.includes('RARE OVERSIZE LAST RESORT ONLY'),'Short token transport is an exceptional fallback');
assert(handoffPolicy.includes('SWEETIEBOT_HANDOFF_GZIP_V1'),'No raw diffs in oversized handoffs');
assert(handoffPolicy.includes('<details>'),'Oversized transport stays collapsed in chat');
assert.equal(MAX_PATCH_BYTES,32*1024*1024,'Larger complete patches remain accepted');
assert(handoffPolicy.includes('BULK CONFLICT RESOLUTION'),'Compact per-hunk merge integration is preferred');
assert(handoffPolicy.includes('MODEL ATTRIBUTION'));
assert(handoffPolicy.includes('assistantModelNumber'));
assert(!handoffPolicy.includes('Co-authored-by: ChatGPT 6 <noreply@openai.com>'));
assert.throws(() => validateResolution({ ...input, results: [{ ...input.results[0],
  assistantModelNumber: 'Codex Web' }] }, selection), /Invalid current web coding model number/);
assert(handoffPolicy.includes('resolutionHunks'),'Model need not output complete Git diffs');

assert(handoffPolicy.includes('#result_gz='),'Primary Apply link uses gzip Base64URL');
assert(handoffPolicy.includes('No raw JSON is output unless the browser requests its second and final fallback'),'Raw JSON is a last-resort fallback');
assert(!handoffPolicy.includes('The complete versioned JSON in a fenced json block in your FINAL assistant response is the primary handoff'),'Raw JSON must not be primary');

assert(handoffPolicy.includes('https://github.com/OWNER/REPO/pull/NUMBER/changes/FULL40SHA'));
assert(handoffPolicy.includes('without Markdown backticks'));

assert(handoffPolicy.includes('Do not create or request a synchronization commit'));
(async () => {
  // Exercise signing selection without accessing the user's private key store.
  const path = require('node:path');
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'resolution-signing-test-'));
  try {
    await fs.mkdir(path.join(directory, '.git'));
    for (const enabled of [true, false]) {
      const created = [];
      const git = async (...args) => {
        if (args[0] === 'config') {
          if (args.at(-1) === 'gpg.format') return 'openpgp';
          if (args.at(-1) === 'user.name') return 'Human';
          if (args.at(-1) === 'user.email') return 'human@example.test';
          return String(enabled);
        }
        if (args[0] === 'ls-tree') return '100644 blob ' + head + '\tfile.txt\0';
        if (args[0] === 'show') return ['Human', 'human@example.test', 'Human', 'human@example.test'].join('\0');
        if (args[0] === 'cat-file') return 'tree ' + base + '\ngpgsig signature\n';
        if (args[0] === 'verify-commit') return '';
        return base;
      };
      const createCommitTree = async ({ identity }) => {
        const args = ['commit-tree', ...(identity.signed ? ['-S'] : [])];
        created.push(args);
        return head;
      };
      const options = { git, directory, headSha: head, baseSha: base, finalTree: base,
        createCommitTree, conflicts: ['file.txt'], decisions: [{ path: 'file.txt', title: '🛠️ Preserve behavior', description: 'Keep both changes.' }],
        author: { name: 'Human', email: 'human@example.test' }, base: 'main', assistantModelNumber: '6.1' };
      await require('../../extension/merge/resolution-commits').createResolutionCommits(options);
      assert.equal(created.length, 2, 'Sign both file decisions and the final synchronization');
      assert(created.every(args => args.includes('-S') === enabled));
      assert(created.every(args => !args.includes('commit.gpgsign=false')));
      const syncMessage = await fs.readFile(path.join(directory, '.git', 'sweetiebot-resolution-message'), 'utf8');
      assert(syncMessage.includes('Co-authored-by: ChatGPT 6.1 <noreply@openai.com>'));
      await assert.rejects(require('../../extension/merge/resolution-commits').createResolutionCommits({
        ...options, assistantModelNumber: undefined }), /require the web generator model number/);
      assert(!syncMessage.includes('Co-authored-by: Codex Web <noreply@openai.com>'));

      if (enabled) {
        await assert.rejects(require('../../extension/merge/resolution-commits').createResolutionCommits({ ...options,
          createCommitTree: async () => { throw Error('Signing failed'); } }),
        /Signing failed/, 'Signing failures must stop preparation, never retry unsigned');
      }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  // The final two-parent Lindsey merge must honor the configured signer, not
  // just the intermediate resolution commits.
  const { localAuthorMerge } = require('../../extension/merge/local-author-merge');
  const signingDirectory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'lindsey-merge-signing-'));
  try {
    await fs.mkdir(path.join(signingDirectory, '.git'));
    for (const testCase of [
      { configured: false },
      { configured: true },
      { configured: false, required: true },
      { configured: true, signerFailure: true },
      { configured: true, missingSignature: true },
      { configured: true, githubRejectedSignature: true }
    ]) {
      const { configured, required = false, signerFailure = false,
        missingSignature = false, githubRejectedSignature = false } = testCase;
      const signing = true;
      const expectedSigned = !signerFailure && !missingSignature;
      const sha = 'c'.repeat(40), tree = 'd'.repeat(40);
      const author = { name: 'Human', email: 'human@example.test' };
      const message = '🐞 Signed Lindsey merge\n\nCo-authored-by: ChatGPT 6 <noreply@openai.com>';
      const original = { state: 'open', draft: false, merged: false, title: '🐞 Signed Lindsey merge',
        head: { ref: 'feature', sha: head, repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } } };
      let pushes = 0, created = 0;
      const api = async endpoint => {
        if (endpoint === 'repos/owner/repo/pulls/12') {
          return pushes ? { ...original, state: 'closed', merged: true,
            merge_commit_sha: sha } : original;
        }
        if (endpoint === 'repos/owner/repo/branches/main') {
          return { protected: false, commit: { sha: base } };
        }
        if (endpoint === 'repos/owner/repo/rules/branches/main') return [];
        if (endpoint.includes('/check-runs?')) return { check_runs: [] };
        if (endpoint.includes('/check-suites?')) return { check_suites: [] };
        if (endpoint.includes('/status?')) return { statuses: [] };
        if (endpoint === 'repos/owner/repo/commits/' + sha) {
          return { commit: { author, message, verification: {
            verified: expectedSigned && !githubRejectedSignature,
            reason: !expectedSigned ? 'unsigned' : githubRejectedSignature ? 'bad_signature' : 'valid'
          } }, parents: [{ sha: base }, { sha: head }] };
        }
        throw Error('Unexpected Lindsey signing API read: ' + endpoint);
      };
      const git = async (...args) => {
        if (args[0] === 'config') {
          if (args.at(-1) === 'gpg.format') return 'openpgp';
          if (args.at(-1) === 'user.name') return author.name;
          if (args.at(-1) === 'user.email') return author.email;
          assert.deepEqual(args, ['config', '--type=bool', '--default', 'false', '--get', 'commit.gpgsign']);
          return String(configured);
        }
        if (args[0] === 'rev-parse') {
          return { [head + '^{tree}']: tree, [sha + '^1']: base, [sha + '^2']: head }[args[1]];
        }
        if (args[0] === 'show') {
          if (args.includes('--format=%an%x00%ae%x00%cn%x00%ce%x00%B'))
            return [author.name,author.email,author.name,author.email,message+'\n'].join('\0');
          if (args.includes('--format=%an%x00%ae%x00%cn%x00%ce'))
            return [author.name, author.email, author.name, author.email].join('\0');
          return author.name + '\0' + author.email + '\0' + message + '\n';
        }
        if (args[0] === 'verify-commit') return '';
        if (args[0] === 'cat-file') {
          return missingSignature ? 'tree ' + tree + '\n' :
            'tree ' + tree + '\ngpgsig -----BEGIN SSH SIGNATURE-----\n signature-data\n';
        }
        if (args[0] === 'push') {
          assert.equal(args.at(-1), sha + ':refs/heads/main');
          assert(!args.some(arg => arg.startsWith('--force')));
          pushes++;
          return '';
        }
        throw Error('Unexpected Lindsey signing Git command: ' + args.join(' '));
      };
      const createCommitTree = async ({ identity }) => {
        created++;
        assert.equal(identity.signed, created === 1 && signing, 'Prefer signing, then fall back unsigned if unavailable');
        assert.deepEqual(identity.author, author);
        assert.deepEqual(identity.committer, author);
        if (signerFailure && identity.signed) throw Error('signer unavailable');
        return sha;
      };
      const action = () => localAuthorMerge({ repository: 'owner/repo', number: 12,
        original, headSha: head, baseSha: base, tree, author, message,
        git, api, directory: signingDirectory, requireSignedCommit: required, createCommitTree });
      const merged = await action();
      assert.equal(merged.merged, true);
      assert.equal(merged.signed, expectedSigned, 'Signed status reflects the final commit');
      assert.equal(merged.verified, expectedSigned && !githubRejectedSignature,
        'GitHub verification must not block an unverified merge');
      assert.equal(pushes, 1, 'Only one destination push may occur');
      assert.equal(created, signerFailure || missingSignature ? 2 : 1,
        'Retry only commit creation when signing fails');

    }
  } finally { await fs.rm(signingDirectory, { recursive: true, force: true }); }
  for (const bad of [
    { ...input, repository: 'other/repo' }, { ...input, results: [input.results[0], input.results[0]] },
    ...[{ number: 13 }, { headSha: 'c'.repeat(40) }, { baseSha: '' }, { patch: '' }, { patch: 'x'.repeat(MAX_PATCH_BYTES + 1) }]
      .map(change => ({ ...input, results: [{ ...input.results[0], ...change }] }))
  ]) assert.throws(() => validateResolution(bad, selection));
  assert.doesNotThrow(() => validateResolution({ ...input,
    results: [{ ...input.results[0], patch: 'x'.repeat(60001) }] }, selection),
  'A complete previously oversized patch remains accepted without truncation');
  const conflict = 'header\n<<<<<<< HEAD\ncurrent main\n=======\nPR feature\n>>>>>>> feature\nfooter\n';
  const same = [{index:0,choice:'both-ours-first',ours:'current main\n',theirs:'PR feature\n'}];
  assert.equal(applyResolutionHunks(conflict,same),'header\ncurrent main\nPR feature\nfooter\n');
  assert.equal(applyResolutionHunks(conflict,[{index:0,choice:'custom',resolved:'integrated\n'}]),
    'header\nintegrated\nfooter\n','Only the contested region is replaced');
  assert.throws(() => applyResolutionHunks(conflict,[{index:0,choice:'custom',resolved:'<<<<<<< unresolved\n'}]), /markers/);
  assert.throws(() => applyResolutionHunks(conflict,[{index:0,choice:'ours',ours:'stale'}]), /does not match/);
  assert.throws(() => applyResolutionHunks(conflict,[]), /count changed/);
  assert.throws(() => validateResolutionHunks([{path:'../../secrets',hunks:same}]), /safe file/);
  assert.throws(() => validateResolutionHunks([{path:'file.txt',hunks:[{index:1,choice:'ours'}]}]), /ordered/);
  assert.throws(() => validateResolutionHunks([{path:'file.txt',hunks:[{index:0,choice:'custom'}]}]), /ordered/);
  const compactDecision=[{path:'file.txt',title:'🛠️ Keep both sides',description:'Retain the corrected main behavior and PR feature.'}];
  const compactHunks=[{path:'file.txt',hunks:[{index:0,choice:'both-ours-first'}]}];
  const compactInput={...input,results:[{...input.results[0],resolutionHunks:compactHunks,
    decisions:compactDecision,assistantModelNumber:'7.2'}]};
  assert.equal(validateResolution(compactInput,selection)[0].resolutionHunks[0].hunks[0].choice,'both-ours-first');
  assert.throws(() => validateResolution({...compactInput,results:[{...compactInput.results[0],patch:'patch'}]},selection),/never both/);
  assert.throws(() => validateResolution({...compactInput,results:[{...compactInput.results[0],decisions:[]}]},selection),/concrete/);
  await executeResolution(compactInput,selection,{merge:async(_repo,_number,options)=>{
    assert.equal(options.resolutionPatch,null);
    assert.deepEqual(options.resolutionHunks,compactHunks,'Local executor receives only the small conflict choices');
    assert.equal(options.assistantModelNumber, '7.2', 'The web generator version reaches the local executor');
    return {merged:false,status:'synced'};
  }});
  let calls = 0;
  const empty = { ...input, results: [] };
  assert.deepEqual(validateResolution(empty, selection), []);
  assert.deepEqual(await executeResolution(empty, selection, {
    merge: async () => assert.fail('An empty handoff must never invoke Git or GitHub merging')
  }), { repository: selection.repository, results: [] });
  assert.deepEqual(await invokeResolutionCLI(empty, selection, undefined),
    { repository: selection.repository, results: [] },
    'A blocked batch completes through the real child CLI without GitHub writes');
  const result = await executeResolution(input, selection, { merge: async (repo, number, options) => {
    calls++;
    assert.equal(repo, 'owner/repo'); assert.equal(number, 12);
    assert.equal(options.expected.headSha, head); assert.equal(options.expected.base, 'main');
    assert.equal(options.resolutionPatch, null);
    return { merged: true, sha: 'c'.repeat(40) };
  } });
  assert.equal(calls, 1); assert.equal(result.results[0].status, 'merged');
  for (const decisions of [[{ path: '../../outside', title: '🛠️ Preserve behavior', description: 'why' }],
    [{ path: 'file.txt', title: 'Resolve conflicts', description: 'why' }],
    [{ path: 'file.txt', title: '🛠️ Preserve behavior', description: '' }]]) {
    assert.throws(() => validateResolution({ ...input, results: [{ ...input.results[0], decisions }] }, selection));
  }
  const branchOnly = { ...input, results: [{ ...input.results[0], operation: 'sync' }] };
  assert.equal(validateSyncResolution(branchOnly, selection)[0].operation, 'sync');
  assert.throws(() => validateSyncResolution(input, selection), /merging is not authorized/);
  const synced = await executeResolution(branchOnly, selection, { merge: async (repo, number, options) => {
    assert.equal(options.operation, 'sync');
    return { merged: false, status: 'synced', sha: 'c'.repeat(40) };
  } });
  assert.equal(synced.results[0].status, 'synced', 'Branch preparation is never reported as merged');
  const blocked = await executeResolution(input, selection, { merge: async () => { throw Error('Stale base'); } });
  assert.equal(blocked.results[0].status, 'blocked');
  assert.match(blocked.results[0].reason, /Stale/);
  await executeResolution({ ...input, results: [{ ...input.results[0], allowHistoryRewrite: true,
    rewriteReason: 'preserve-human-author' }] }, selection, { merge: async (repo, number, options) => {
    assert.equal(options.allowHistoryRewrite, undefined, 'A web result cannot approve its own history rewrite');
    assert.equal(options.rewriteReason, undefined);
    return { merged: false, status: 'blocked' };
  } });
  await executeResolution(input, selection, { authorHandoff: true, merge: async (repo, number, options) => {
    assert.equal(options.allowHistoryRewrite, undefined, 'Local Git handoff must never authorize rewriting an existing commit');
    assert.equal(options.rewriteReason, undefined);
    assert.equal(options.localGitMerge, true, 'Bot-opened PRs use the local Git integration route');
    return { merged: false, status: 'waiting' };
  } });
  await executeResolution({ ...input, results: input.results.map(item => ({ ...item, operation: 'sync' })) }, selection, { authorHandoff: true, merge: async (repo, number, options) => {
    assert.equal(options.allowHistoryRewrite, undefined, 'Branch-only synchronization never gains rewrite permission');
    return { merged: false, status: 'synced' };
  } });
  const pushedFailure = await executeResolution(input, selection, { merge: async () => {
    throw Object.assign(Error('PR changed after guarded push'), { preparedHead: 'c'.repeat(40), originalHead: head });
  } });
  assert.equal(pushedFailure.results[0].preparedHead, 'c'.repeat(40), 'A post-push stop retains structured commit evidence');
  const progressEvents = [];
  const stderr = new (require('node:events').EventEmitter)();
  await invokeResolutionCLI(input, selection, 'test-token', () => {
    const running = new Promise(resolve => setImmediate(() => {
      stderr.emit('data', 'LINDSEY_PRO');
      stderr.emit('data', 'GRESS {"number":12,"stage":"preparing"}\nnot progress\n');
      stderr.emit('data', 'LINDSEY_PROGRESS {"number":99,"stage":"pushed"}\nLINDSEY_PROGRESS invalid\n');
      stderr.emit('data', 'LINDSEY_PROGRESS {"number":12,"stage":"pushed","sha":"' + 'c'.repeat(40) + '"}\n');
      assert.equal(progressEvents.length, 2, 'Progress reaches the timeline before the child exits');
      resolve({ stdout: JSON.stringify(result) });
    }));
    running.child = { stderr };
    return running;
  }, event => progressEvents.push(event));
  assert.deepEqual(progressEvents.map(event => event.stage), ['preparing', 'pushed']);
  let inputFile;
  await invokeResolutionCLI(input, selection, 'session-token', async (binary, args, options) => {
    inputFile = args[2];
    assert(args[0].endsWith('resolution-cli.js'));
    assert.equal(args[1], '--input');
    assert(options.timeout > 2 * 30 * 60 * 1000,
      'The CLI must outlive both source-head and integrated-head check windows');
    assert.equal(options.env.GH_TOKEN, 'session-token');
    assert(!args.includes('session-token'), 'Never pass credentials in process arguments');
    assert.deepEqual(JSON.parse(await fs.readFile(inputFile, 'utf8')), { input, selection });
    return { stdout: JSON.stringify(result) };
  });
  await assert.rejects(fs.stat(inputFile), /ENOENT/);
  assert.deepEqual(patchPaths('diff --git a/file.txt b/file.txt\n', '1\t1\tfile.txt\0', ['file.txt']), ['file.txt']);
  for (const name of ['../../escape', '/absolute', '.git/config', '.env', '.env.local', 'keys/private.pem', 'secrets.json', 'folder/id_rsa', 'folder\\escape']) {
    assert.equal(Boolean(safePatchPath(name)), false, name);
    assert.throws(() => patchPaths('', '1\t1\t' + name + '\0', [name]));
  }
  assert.throws(() => patchPaths('new file mode 120000\n', '1\t0\tfile.txt\0', ['file.txt']), /regular text/);
  assert.throws(() => patchPaths('', '1\t1\tunrelated.txt\0', ['file.txt']), /unrelated/);
  assert.deepEqual(patchPaths('', '1\t1\ttests/test_regression.js\0', ['file.txt'], { allowCheckRepairTests: true }), ['tests/test_regression.js']);
  assert.throws(() => patchPaths('', '1\t1\ttests/test_regression.js\0', ['file.txt']), /unrelated/);
  assert.throws(() => patchPaths('', '1\t1\tproduction.js\0', ['file.txt'], { allowCheckRepairTests: true }), /unrelated/);
  assert.throws(() => patchPaths('GIT binary patch\n', '', ['file.txt']), /regular text/);

  let executions = 0, finish;
  const bridge = await createMergeHandoff(selection, { execute: async received => {
    assert.deepEqual(received, input, 'A staged digest resolves to the exact original handoff');
    executions++;
    await new Promise(resolve => { finish = resolve; });
    return result;
  } });
  try {
    const url = new URL(bridge.url);
    const post = (data, headers = {}, destination = url) => new Promise((resolve, reject) => {
      const request = http.request(destination, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url.origin, ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(data));
    });
    const intake = await fetch(url);
    assert.equal(intake.status, 200, 'GET only serves the intake page');
    const intakeHtml = await intake.text();
    assert(intakeHtml.includes('.merge-header .dashboard-brand'), 'Use the bulk dashboard header style');
    assert(!intakeHtml.includes('__MERGE_HEADER_CSS__'), 'Serve the resolved local stylesheet');
    assert.equal(executions, 0);
    assert.equal((await (await fetch(bridge.url + '/status')).json()).phase, 'ready');
    assert.equal((await post(input, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await post(input, { Host: 'evil.invalid' })).status, 404);
    assert.equal((await post({ ...input, results: [{ ...input.results[0], number: 99 }] })).status, 400);
    assert.equal(executions, 0);
    const compressed = gzipSync(JSON.stringify(input));
    const data = compressed.toString('base64url');
    const id = createHash('sha256').update(compressed).digest('hex');
    assert.equal((await post({ id, data }, { Origin: 'https://evil.invalid' }, bridge.url + '/stage')).status, 403,
      'Cross-origin requests cannot stage untrusted Git changes');
    assert.equal((await post({ id: '0'.repeat(64), data }, {}, bridge.url + '/stage')).status, 400,
      'Staging verifies the SHA-256 digest before retention');
    assert.equal((await post({ id, data: data.slice(0, -8) }, {}, bridge.url + '/stage')).status, 400,
      'Incomplete compressed payloads cannot stage');
    assert.equal(executions, 0, 'Staging never runs Git');
    assert.equal((await post({ id, data }, {}, bridge.url + '/stage')).status, 201);
    assert.equal((await post({ id, data }, {}, bridge.url + '/stage')).status, 200,
      'Repeated staging of the same digest is idempotent');
    assert.equal((await post({ handoffId: '0'.repeat(64) })).status, 400,
      'Wrong or unstaged short links cannot trigger Git');
    assert.equal(executions, 0, 'Staged data is never executed without the matching Apply');
    const pending = post({ handoffId: id });
    const deadline = Date.now() + 5000;
    while (!finish && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert(finish, 'Valid POST should reach the local executor');
    assert.equal((await (await fetch(bridge.url + '/status')).json()).phase, 'running', 'Reload can observe execution without repeating it');
    assert.equal((await post(input)).status, 409, 'Do not run a concurrent duplicate');
    assert.equal((await post({id,data},{},bridge.url+'/stage')).status,409,'Do not replace an executed handoff');
    finish();
    assert.equal((await pending).status, 200);
    const recovered = await (await fetch(bridge.url + '/status')).json();
    assert.equal(recovered.phase, 'finished');
    assert.deepEqual(recovered.result, result);
    assert.deepEqual(await (await post(input)).json(), result, 'Replay returns the recorded result');
    assert.equal(executions, 1);
  } finally { bridge.dispose(); }
  console.log('Selected-patch validation, local CLI intake, origin guards, replay and credential transport checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
