'use strict';
const assert = require('node:assert/strict');
const { ponyProfilePrompt, showPublishedPonyProfile } = require('../efs/pull_request');

async function run() {
  const instructions = '## Local Sweetiebot pony profile\nVerify canon or fandom naming history and character facts.\n## Conversation provenance\nKeep source metadata separate.\n## Publishing\ngithub_create_pull_request';
  const pony = { slug: 'fern-flare', name: 'Fern Flare', packId: 'g4-mares' };
  const prompt = ponyProfilePrompt({ pony, instructions, number: 42 });
  assert.match(prompt, /PR #42 has already been published successfully/);
  assert.match(prompt, /Do not create, edit, comment on/);
  assert.match(prompt, /voice actor/);
  assert.match(prompt, /sourced images/);
  assert.match(prompt, /canon or fandom naming history/);
  assert(!prompt.includes('## Publishing'));
  assert(!prompt.includes('github_create_pull_request'));
  const calls = [];
  const vscode = { commands: {
    async executeCommand(...args) { calls.push(args); },
    async getCommands() { return ['workbench.action.browser.open']; },
  } };
  const dependencies = { readPony: async branch => { assert.equal(branch, pony.slug); return pony; },
    readInstructions: async () => instructions, resolveProject: async () => '' };
  await showPublishedPonyProfile(vscode, {}, { branch: pony.slug, repositoryPath: '/repo', number: 42 }, dependencies);
  assert.deepEqual(calls[0], ['sweetiebot.setPonyProfile', pony]);
  assert.equal(calls[1][0], 'workbench.action.browser.open');
  const url = new URL(calls[1][1].url);
  assert.equal(url.origin, 'https://chatgpt.com');
  assert.equal(url.searchParams.get('q'), prompt);
  assert.equal(url.searchParams.get('sweetiebot_pr'), '1');
  assert.equal(calls.length, 2);
  calls.length = 0;
  await showPublishedPonyProfile(vscode, {}, { branch: 'ordinary', number: 43 }, {
    readPony: async () => undefined, readInstructions: () => assert.fail('Unmatched branches should not open a chat'),
  });
  assert.deepEqual(calls, [['sweetiebot.setPonyProfile', undefined]]);
  calls.length = 0;
  await showPublishedPonyProfile(vscode, {}, { branch: pony.slug, number: 42 }, { ...dependencies, resolveProject: async () => undefined });
  assert.equal(calls.length, 1, 'Cancelled project setup must not open a regular chat');
  console.log('Published PR pony profile checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
