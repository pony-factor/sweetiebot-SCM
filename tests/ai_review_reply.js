'use strict';
const assert = require('node:assert/strict');
const {
  parseRemote, reviewSelection, checkPublished, parseAssessment, replyBody
} = require('../extension/codex/ai_review_reply');

async function run() {
  assert.equal(parseRemote('git@github.com:pony-factor/sweetiebot-SCM.git'),
    'pony-factor/sweetiebot-SCM');
  assert.equal(parseRemote('https://github.com/pony-factor/sweetiebot-SCM'),
    'pony-factor/sweetiebot-SCM');
  assert.equal(parseRemote('https://evil.example/repo'), null);
  assert.equal(parseRemote('https://github.com/a/b/other'), null);
  assert.equal(reviewSelection([
    { id: 'a', isResolved: false, viewerCanReply: true, viewerCanResolve: true, path: 'src/a.js', comments: { nodes: [{ body: 'fix' }] } },
    { id: 'b', isResolved: true, viewerCanReply: true, viewerCanResolve: true, path: 'src/a.js', comments: { nodes: [{ body: 'done' }] } },
    { id: 'c', isResolved: false, viewerCanReply: true, viewerCanResolve: false, path: 'src/a.js', comments: { nodes: [{ body: 'forbidden' }] } }
  ]).length, 1);
  assert.deepEqual(parseAssessment('{"resolved":true,"explanation":"Null input now returns early."}'),
    { resolved: true, explanation: 'Null input now returns early.' });
  assert.throws(() => parseAssessment('{"resolved":"yes","explanation":"Maybe"}'));
  const sha = 'b'.repeat(40), before = 'a'.repeat(40);
  const job = {
    root: '/repo', remote: 'origin', branch: 'fix/review', before,
    repo: 'pony-factor/sweetiebot-SCM', number: 42,
    path: 'src/a.js', threadId: 'THREAD42', comment: 'Handle null'
  };
  const calls = [];
  const fake = async (_root, ...args) => {
    calls.push(args);
    if (args[0] === 'symbolic-ref') return job.branch;
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'rev-list') return '1';
    if (args[0] === 'ls-remote') return sha + '\trefs/heads/' + job.branch;
    if (args[0] === 'diff' && args.includes('--name-only')) return job.path;
    return 'diff --git a/src/a.js b/src/a.js\n+if (!value) return;';
  };
  const result = await checkPublished(job, fake);
  assert.equal(result.sha, sha);
  assert.match(result.patch, /return/);
  assert.equal(calls.at(-1)[0], 'diff');
  assert.match(replyBody(job, sha, 'Null input now returns early.'), /sweetiebot-ai-review:THREAD42/);
  const notPushed = await checkPublished(job, async (root, ...args) =>
    args[0] === 'ls-remote' ? before + '\trefs/heads/fix/review' : fake(root, ...args));
  assert.equal(notPushed, null, 'do not respond before push');
  await assert.rejects(() => checkPublished(job, async (root, ...args) =>
    args[0] === 'rev-list' ? '2' : fake(root, ...args)), /More than one commit/);
  await assert.rejects(() => checkPublished(job, async (root, ...args) =>
    args[0] === 'diff' && args.includes('--name-only') ? 'src/other.js' : fake(root, ...args)),
  /does not change the file/);
  console.log('AI review reply safeguards OK');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
