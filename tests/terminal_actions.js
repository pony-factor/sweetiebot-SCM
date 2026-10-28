'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  COPY_TERMINAL_CONTENTS_COMMAND,
  TERMINAL_SELECT_ALL_COMMAND,
  TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND,
  registerTerminalActions
} = require('../extension/ui/terminal_actions');

async function run() {
  const calls = [];
  const notices = [];
  let shouldFail = false;
  const handlers = new Map();
  const vscode = {
    window: {
      activeTerminal: { name: 'shell' },
      showInformationMessage: message => notices.push(['info', message]),
      showErrorMessage: message => notices.push(['error', message])
    },
    commands: {
      registerCommand(command, handler) {
        handlers.set(command, handler);
        return { dispose() { handlers.delete(command); } };
      },
      async executeCommand(command) {
        calls.push(command);
        if (shouldFail) throw new Error('terminal unavailable');
      }
    }
  };
  const context = { subscriptions: [] };
  registerTerminalActions(vscode, context);
  assert.equal(context.subscriptions.length, 1);
  const copy = handlers.get(COPY_TERMINAL_CONTENTS_COMMAND);
  assert.equal(typeof copy, 'function');

  await copy();
  assert.deepEqual(calls, [TERMINAL_SELECT_ALL_COMMAND, TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND]);
  assert.deepEqual(notices, []);

  vscode.window.activeTerminal = undefined;
  calls.length = 0;
  await copy();
  assert.deepEqual(calls, []);
  assert.deepEqual(notices.at(-1), ['info', 'No active terminal to copy.']);

  vscode.window.activeTerminal = { name: 'shell' };
  shouldFail = true;
  notices.length = 0;
  await copy();
  assert.deepEqual(calls, [TERMINAL_SELECT_ALL_COMMAND]);
  assert.match(notices.at(-1)[1], /Unable to copy terminal contents: terminal unavailable/);

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'package.json'), 'utf8'));
  assert.ok(manifest.activationEvents.includes('onCommand:' + COPY_TERMINAL_CONTENTS_COMMAND));
  assert.equal(manifest.contributes.commands.find(item => item.command === COPY_TERMINAL_CONTENTS_COMMAND)?.title,
    'Copy Entire Terminal Contents');
  assert.ok(manifest.contributes.menus['terminal/context'].some(item => item.command === COPY_TERMINAL_CONTENTS_COMMAND));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'extension', 'extension.js'), 'utf8'),
    /registerTerminalActions\(vscode, context\)/);

  context.subscriptions[0].dispose();
  assert.equal(handlers.size, 0);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
