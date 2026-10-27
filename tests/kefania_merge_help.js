'use strict';
const assert = require('node:assert/strict');
const { openKefaniaMergeHelp } = require('../extension/codex/kefania_merge_help');

(async () => {
  const vscode = {}, context = {}, rootUri = { fsPath: '/test/worktree' };
  const repo = 'pony-factor/sweetiebot-SCM', sha = 'a'.repeat(40);
  const published = { number: 479, url: 'https://github.com/' + repo + '/pull/479', head: 'feature', base: 'main' };
  const pr = { number:479, title:'🖌️ Improve merge conflict notice', html_url:published.url,
    state:'open', merged_at:null, head:{ref:'feature',sha,repo:{full_name:repo}},
    base:{ref:'main',repo:{full_name:repo}} };
  let launched = 0, observed;
  const deps = {
    session:async () => ({accessToken:'verified-token'}),
    getPR:async (_, token, target, endpoint) => {
      assert.equal(token,'verified-token');assert.equal(target,repo);assert.equal(endpoint,'/pulls/479');return pr;
    },
    start:(vs,selection,token,opts) => {
      launched++; observed=selection;
      assert.equal(vs,vscode);assert.equal(token,'verified-token');
      assert.equal(opts.context,context);assert.equal(opts.rootUri,rootUri);
    }
  };
  assert.equal(await openKefaniaMergeHelp(vscode,context,rootUri,repo,published,deps),true);
  assert.equal(launched,1);
  assert.deepEqual(observed.pullRequests[0],{number:479,title:pr.title,url:published.url,head:'feature',base:'main',headSha:sha});
  pr.head.ref='unexpected';
  await assert.rejects(openKefaniaMergeHelp(vscode,context,rootUri,repo,published,deps),/changed or closed/);
  assert.equal(launched,1,'Stale head must not launch a resolution session');
  pr.head.ref='feature';pr.merged_at='2026-10-24T18:00:00Z';
  await assert.rejects(openKefaniaMergeHelp(vscode,context,rootUri,repo,published,deps),/changed or closed/);
  assert.equal(launched,1,'Merged PRs cannot reopen a resolution workflow');
  console.log('Kefania shares live Lindsey conflict recovery without duplicating actions.');
})().catch(error=>{console.error(error);process.exitCode=1;});
