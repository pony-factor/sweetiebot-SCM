'use strict';

const assert = require('node:assert/strict');
const { normalizeChatgptProjectUrl, chatgptPromptUrl } = require('../efs/chatgpt_project');

const project = 'https://chatgpt.com/g/g-p-6ac73804b6b081918ef8d1f0c88d4ba0/project';
const prompt = 'Merge #12 & #13\nVerify the diff.';
assert.equal(normalizeChatgptProjectUrl('  '), '');
assert.equal(normalizeChatgptProjectUrl(project + '/'), project);
assert.equal(chatgptPromptUrl(prompt), 'https://chatgpt.com/?q=' + encodeURIComponent(prompt));
const scoped = new URL(chatgptPromptUrl(prompt, project));
assert.equal(scoped.origin + scoped.pathname, project);
assert.equal(scoped.searchParams.get('q'), prompt);
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
}
console.log('ChatGPT project destination checks passed.');
