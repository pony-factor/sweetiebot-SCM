'use strict';
const assert = require('node:assert/strict');
const { stackedPullRequestBase, verifyPublishedBranch } = require('../extension/github/pull_request');
(async () => {
  let state = 'MERGED', ancestry = 0;
  const run = async (program, args) => {
    if (program === 'gh') return { stdout: JSON.stringify({state, headRefName:'parent', baseRefName:'main'}) };
    if (args[0] === 'config') {
      if (args.at(-1).includes('branch.child.')) return {stdout:'parent'};
      throw Object.assign(new Error('unset'), {code:1});
    }
    ancestry++; return {stdout:''};
  };
  assert.equal(await stackedPullRequestBase('/repo','child','main',run),'main');
  assert.equal(ancestry,0,'A squash-merged parent must no longer be used as the base');
  state='OPEN';
  assert.equal(await stackedPullRequestBase('/repo','child','main',run),'parent');
  assert.equal(ancestry,1);
  state='CLOSED';
  await assert.rejects(stackedPullRequestBase('/repo','child','main',run), /closed without merging/);
  await assert.rejects(verifyPublishedBranch('/repo', 'missing', 'origin', async () => ({stdout:''})), /not published/);
  await verifyPublishedBranch('/repo', 'child', 'origin', async () => ({stdout:'abc\trefs/heads/child\n'}));
  console.log('Stack parent PR base checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
