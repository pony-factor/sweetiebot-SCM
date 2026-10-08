'use strict';

const assert = require('node:assert/strict');
const { resolveChatgptActionProject } = require('../efs/chatgpt_project');

async function run() {
  const project = 'https://chatgpt.com/g/g-p-project123/project';
  const state = new Map();
  const calls = [];
  let configured = '';
  let choice = 'Set up project';
  let input = project + '/';
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    Uri: { parse: value => ({ url: value }) },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'scmToolkit');
        return {
          get(key) { assert.equal(key, 'chatgptProjectUrl'); return configured; },
          async update(key, value, target) {
            assert.equal(key, 'chatgptProjectUrl');
            assert.equal(target, 1);
            configured = value;
            calls.push(['updated', value]);
          }
        };
      }
    },
    env: {
      async openExternal(uri) { calls.push(['opened', uri.url]); return true; }
    },
    window: {
      async showInformationMessage(message, options, ...actions) {
        assert.match(message, /private ChatGPT project/);
        assert.equal(options.modal, true);
        assert.deepEqual(actions, ['Set up project', 'Use regular chats']);
        calls.push(['choice', choice]);
        return choice;
      },
      async showInputBox(options) {
        assert.match(options.prompt, /create or open an unshared project/);
        assert.equal(options.ignoreFocusOut, true);
        assert.match(options.validateInput('https://example.com'), /ChatGPT project URL/);
        assert.match(options.validateInput('   '), /Paste a ChatGPT project URL/);
        assert.equal(options.validateInput(project), undefined);
        calls.push(['input']);
        return input;
      }
    }
  };
  const context = {
    globalState: {
      get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
      async update(key, value) { state.set(key, value); }
    }
  };

  // Cancel never creates an unscoped general chat.
  choice = undefined;
  assert.equal(await resolveChatgptActionProject(vscode, context), undefined);
  assert.equal(calls.some(call => call[0] === 'opened'), false);

  // A user can explicitly opt into normal chats once; no repeat prompts.
  calls.length = 0;
  choice = 'Use regular chats';
  assert.equal(await resolveChatgptActionProject(vscode, context), '');
  assert.equal(await resolveChatgptActionProject(vscode, context), '');
  assert.deepEqual(calls, [['choice', 'Use regular chats']]);

  // Configured project takes precedence over the regular-chat opt-out.
  configured = project;
  calls.length = 0;
  assert.equal(await resolveChatgptActionProject(vscode, context), project);
  assert.deepEqual(calls, []);
  configured = '';
  state.set('scmToolkit.useRegularChatForWebActions', false);

  choice = 'Set up project';
  calls.length = 0;
  assert.equal(await resolveChatgptActionProject(vscode, context), project);
  assert.equal(configured, project);
  assert.deepEqual(calls, [
    ['choice', 'Set up project'],
    ['opened', 'https://chatgpt.com/'],
    ['input'],
    ['updated', project]
  ]);
  assert.equal(state.get('scmToolkit.useRegularChatForWebActions'), false);

  configured = '';
  input = undefined;
  calls.length = 0;
  assert.equal(await resolveChatgptActionProject(vscode, context), undefined);
  assert(!calls.some(call => call[0] === 'updated'));

  // A failed project-setting write must not silently fall back to a regular chat.
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: () => '',
    async update() { throw new Error('Settings are read-only'); }
  });
  input = project;
  await assert.rejects(resolveChatgptActionProject(vscode, context), /Settings are read-only/);
  vscode.workspace.getConfiguration = originalGetConfiguration;
  console.log('ChatGPT private project onboarding checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
