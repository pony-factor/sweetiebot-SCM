'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CLOSE_ALL_EDITORS_COMMAND,
  VSCODE_CLOSE_ALL_EDITORS_COMMAND,
  registerEditorActions
} = require('../efs/editor_actions');

async function run() {
  const handlers = new Map();
  const executed = [];
  const vscode = {
    commands: {
      registerCommand(command, handler) {
        handlers.set(command, handler);
        return { dispose() {} };
      },
      async executeCommand(command) {
        executed.push(command);
        return 'closed';
      }
    }
  };
  const context = { subscriptions: [] };

  registerEditorActions(vscode, context);

  assert.equal(context.subscriptions.length, 1);
  assert.equal(typeof handlers.get(CLOSE_ALL_EDITORS_COMMAND), 'function');

  const result = await handlers.get(CLOSE_ALL_EDITORS_COMMAND)();
  assert.equal(result, 'closed');
  assert.deepEqual(executed, [VSCODE_CLOSE_ALL_EDITORS_COMMAND]);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'efs', 'package.json'), 'utf8')
  );
  assert.ok(manifest.activationEvents.includes(`onCommand:${CLOSE_ALL_EDITORS_COMMAND}`));

  const contribution = manifest.contributes.commands.find(
    command => command.command === CLOSE_ALL_EDITORS_COMMAND
  );
  assert.equal(contribution?.title, 'Close All Editors');
  assert.equal(contribution?.icon, '$(close-all)');

  const titleAction = manifest.contributes.menus['editor/title'].find(
    item => item.command === CLOSE_ALL_EDITORS_COMMAND
  );
  assert.equal(titleAction?.group, 'navigation@100');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
