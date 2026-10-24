'use strict';
const assert = require('node:assert/strict');
const { publishBlockerReport, firstDiffAnchor } = require('../efs/merge_blocker_report');
const pr = { number: 68, title: 'Feature', headSha: 'a'.repeat(40), head: 'feature', base: 'main' };
assert.deepEqual(firstDiffAnchor('@@ -4 +4,2 @@\n context\n+new'), { line: 5, side: 'RIGHT' });
assert.equal(firstDiffAnchor('not a patch'), null);
(async () => {
  let writes = [], comments = [], moved = false;
  const api = async (endpoint, options) => {
    if (options) {
      writes.push(options); comments = [{ id: 1, path: 'options.html', user: { login: 'me' }, body: options.body.body }];
      return { html_url: 'https://github.com/o/r/pull/68#discussion_r1' };
    }
    if (endpoint === 'user') return { login: 'me' };
    if (endpoint.includes('/branches/')) return { commit: { sha: 'b'.repeat(40) } };
    if (endpoint.includes('/files?')) return [{ filename: 'options.html', patch: '@@ -4 +4,2 @@\n context\n+new' }];
    if (endpoint.includes('/comments?')) return comments;
    return { state: 'open', title: pr.title, head: { sha: moved ? 'c'.repeat(40) : pr.headSha, ref: pr.head }, base: { ref: pr.base } };
  };
  const run = () => publishBlockerReport({ repository: 'o/r', pr, reason: 'Local patch stopped.', paths: ['options.html'], api });
  assert((await run()).posted); assert.equal(writes[0].body.line, 5); assert.equal(writes[0].body.commit_id, pr.headSha);
  assert(writes[0].body.body.includes('sweetiebot-merge-options'));
  assert((await run()).posted); assert.equal(writes[1].method, 'PATCH', 'Update the existing code thread');
  moved = true;
  const stopped = await run(); assert(!stopped.posted); assert(stopped.options.length > 0, 'Local choices survive failed GitHub publication');
  assert.equal(writes.length, 2, 'Never post against an unrelated changed head');
  console.log('Blocker code anchors, snapshots, deduplication and local fallback choices passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
