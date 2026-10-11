'use strict';
const assert = require('node:assert/strict');
const { boundedLaunch, ponyPrompt, prRules, MAX_LAUNCH_BYTES, openWorkflow } = require('../efs/pr_workflows');
const { chatgptPullRequestUrl } = require('../efs/chatgpt_project');

(async () => {
  const evidence = {instructions:'Do not duplicate these rules.',files:[{filename:'unicode.md',patch:'🦄 漢字 &'.repeat(20000)}]};
  const launch = boundedLaunch(data => JSON.stringify(data), prompt => chatgptPullRequestUrl(prompt), evidence);
  assert(Buffer.byteLength(launch.url) <= MAX_LAUNCH_BYTES);
  assert.equal(launch.evidence.files[0].filename, 'unicode.md');
  assert(launch.evidence.files[0].patchTruncated);
  assert(launch.evidence.incomplete);
  assert(!launch.evidence.instructions);
  assert(!evidence.incomplete, 'Budgeting does not mutate publication evidence');
  const emojiLaunch = boundedLaunch(data => data.files[0].patch, prompt => chatgptPullRequestUrl(prompt),
    {files:[{patch:'🦄'.repeat(20001)}]});
  assert(Buffer.byteLength(emojiLaunch.url) <= MAX_LAUNCH_BYTES, 'Truncation must preserve complete emoji');
  assert.throws(() => boundedLaunch(() => '🦄'.repeat(20000), prompt => chatgptPullRequestUrl(prompt)), /budget/);
  const rules = '## Description\nExplain changes.\n\n## Local Sweetiebot pony profile\nPublish the pull request normally first. After a successful publication, add a compact pony profile to the assistant\'s chat response.\nVerify sources.\n\n## Publishing\nPublish normally.';
  assert(!prRules(rules).includes('Verify sources.'));
  const profile = ponyPrompt({slug:'bushel'}, rules, 'http://127.0.0.1:1234/kefania-draft/test/pony');
  assert(profile.includes('Verify sources.'));
  assert(!profile.includes('Publish the pull request normally first'));
  assert(!profile.includes('Explain changes.'));
  const userTab = {name:'User work'}, workflowTab = {name:'Draft'}, anotherTab = {name:'Later user work'};
  const group = {tabs:[userTab]};
  const closed = [];
  const vscode = {window:{tabGroups:{all:[group],async close(tab){closed.push(tab);group.tabs=group.tabs.filter(item=>item!==tab);}}},commands:{async executeCommand(){group.tabs.push(workflowTab);}}};
  const close = await openWorkflow(vscode, launch.url);
  group.tabs.push(anotherTab);
  await close(); await close();
  assert.deepEqual(closed,[workflowTab], 'Close only the owned intermediate tab, once');
  assert.deepEqual(group.tabs,[userTab,anotherTab]);
  console.log('Independent workflow budget and tab ownership checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
