'use strict';

const assert = require('node:assert/strict');
const { normalizeChatgptProjectUrl, resolveChatgptReviewProjectUrl, chatgptPromptUrl, chatgptPullRequestUrl, chatgptMergeUrl } = require('../efs/codex/chatgpt_project');

const project = 'https://chatgpt.com/g/g-p-6ac73804b6b081918ef8d1f0c88d4ba0/project';
const prompt = 'Merge #12 & #13\nVerify the diff.';
assert.equal(normalizeChatgptProjectUrl('  '), '');
assert.equal(normalizeChatgptProjectUrl(project + '/'), project);
assert.equal(chatgptPromptUrl(prompt), 'https://chatgpt.com/?q=' + encodeURIComponent(prompt));
const scoped = new URL(chatgptPromptUrl(prompt, project));
assert.equal(scoped.origin + scoped.pathname, project);
assert.equal(scoped.searchParams.get('q'), prompt);
const merge = new URL(chatgptMergeUrl(prompt, project));
assert.equal(merge.origin + merge.pathname, project);
assert.equal(merge.search, '', 'Merge prompts are not sent as HTTP query strings');
assert.equal(new URLSearchParams(merge.hash.slice(1)).get('sweetiebot_merge'), '1');
assert.equal(new URLSearchParams(merge.hash.slice(1)).get('q'), prompt);
assert.equal(new URLSearchParams(new URL(chatgptMergeUrl(prompt)).hash.slice(1)).get('q'), prompt);
for (const invalid of [
  'https://chatgpt.com.evil.test/g/g-p-example/project',
  'http://chatgpt.com/g/g-p-example/project',
  'https://chatgpt.com/g/g-p-example/project?redirect=https://evil.test',
  'https://chatgpt.com/g/g-p-example/project#fragment',
  'https://user@chatgpt.com/g/g-p-example/project',
  'https://chatgpt.com/g/g-p-example/not-a-project',
  'https://chatgpt.com/',
  'javascript:alert(1)',
  'https://chatgpt.com/g/g-p-example/project%2felse'
]) {
  assert.throws(() => normalizeChatgptProjectUrl(invalid), /ChatGPT project URL/);
  assert.throws(() => chatgptPromptUrl(prompt, invalid), /ChatGPT project URL/);
  assert.throws(() => chatgptMergeUrl(prompt, invalid), /ChatGPT project URL/);
}
console.log('ChatGPT project destination checks passed.');

const large = prompt.repeat(6000);
const pr = new URL(chatgptPullRequestUrl(large, project));
assert.equal(pr.search, '');
assert.equal(pr.origin + pr.pathname, project);
assert.equal(new URLSearchParams(pr.hash.slice(1)).get('q'), large);

const config = (review, shared) => ({get(key) {
  if (key === 'chatgptReviewProjectUrl') return review;
  if (key === 'chatgptProjectUrl') return shared;
  throw new Error('Unexpected setting: ' + key);
}});
const separateProject = 'https://chatgpt.com/g/g-p-optional123/project';
assert.equal(resolveChatgptReviewProjectUrl(config('', '')), '');
assert.equal(resolveChatgptReviewProjectUrl(config('', project)), project,
  'blank review destination inherits shared project');
assert.equal(resolveChatgptReviewProjectUrl(config(separateProject + '/', project)), separateProject,
  'dedicated review project overrides PR/merge destination');
assert.equal(resolveChatgptReviewProjectUrl(config(separateProject, '')), separateProject);
assert.throws(() => resolveChatgptReviewProjectUrl(config('https://evil.example/project', project)),
  /ChatGPT project URL/, 'invalid review setting fails closed');
