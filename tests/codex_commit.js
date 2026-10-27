'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
function callback(name) {
  const match = source.match(new RegExp(`    const ${name} = ([\\s\\S]*?)\\n    };`));
  assert(match, `${name} callback exists`);
  return `const ${name} = ${match[1]}\n    };`;
}

async function run() {
  const provider = {};
  const input = { repository: { provider }, _value: 'Fix button',
    get value() { return this._value; },
    setValue(value) { this._value = value; }
  };
  const calls = [];
  const errors = [];
  const context = vm.createContext({
    currentInput: input,
    currentRepositoryUri: { scheme: 'file', path: '/selected-repository' },
    pending: false,
    deletingBranch: false,
    committingWithCodex: false,
    codexButton: {},
    settings: { codexCoauthor: true },
    scmToolkitWithCodexCoauthor: (message, settings) => message + '\n\nCo-authored-by: Codex <noreply@openai.com>',
    scmToolkitCoauthorTrailer: () => 'Co-authored-by: Codex <noreply@openai.com>',
    configuration: { getValue: name => name === 'scmToolkit.durableBackgroundCommits' ? context.durable : 'push' },
    durable: true,
    notifications: { error: error => errors.push(error) },
    commands: { async executeCommand(id, ...args) { calls.push({ id, args, message: input.value }); } }
  });
  vm.runInContext(`${callback('refreshCodexCommit')}\n${callback('commitWithCodex')}\nthis.refresh = refreshCodexCommit; this.commit = commitWithCodex;`, context);
  context.refresh();
  assert.equal(context.codexButton.disabled, true);
  provider.acceptInputCommand = { id: 'provider.commit', arguments: ['selected-repository'] };
  context.refresh();
  assert.equal(context.codexButton.disabled, false, 'Git registration after bind enables the button');
  provider.acceptInputCommand = { id: 'provider.updatedCommit', arguments: ['updated-repository'] };
  await context.commit({ stopPropagation() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'sweetiebot.commitWithCodex');
  assert.equal(calls[0].args[0], context.currentRepositoryUri);
  assert.equal(calls[0].args[1].message, 'Fix button');
  assert.equal(calls[0].args[1].trailer, 'Co-authored-by: Codex <noreply@openai.com>');
  assert.equal(calls[0].args[1].codexCommitContext, undefined);
  assert.equal(input.value, 'Fix button', 'No unconfirmed backend result clears the message');
  assert.deepEqual(errors, []);

  // Empty messages are allowed only when the backend will generate from Codex context.
  calls.length = 0;
  input.setValue('');
  context.settings.codexCommitContext = true;
  await context.commit({ stopPropagation() {} });
  assert.deepEqual(calls.map(call => call.id), ['sweetiebot.commitWithCodex']);
  assert.equal(calls[0].args[1].message, '');
  assert.equal(calls[0].args[1].codexCommitContext, true);
  assert.equal(input.value, '');

  context.commands.executeCommand = async () => { throw new Error('Commit failed'); };
  await context.commit({ stopPropagation() {} });
  assert.equal(errors.at(-1).message, 'Commit failed');
  assert.equal(context.codexButton.disabled, false);

  // The extension owns generation, queueing, signing, and pushing; the picker
  // only clears an unchanged message after an explicitly completed commit.
  context.commands.executeCommand = async (id, ...args) => {
    calls.push({ id, args, message: input.value });
    return { committed: true, queued: false };
  };
  calls.length = 0;
  input.setValue('Fast explicit subject');
  await context.commit({ stopPropagation() {} });
  assert.deepEqual(calls.map(call => call.id), ['sweetiebot.commitWithCodex']);
  assert.equal(calls[0].args[1].message, 'Fast explicit subject');
  assert.equal(input.value, '', 'Confirmed direct commit clears the unchanged input');

  context.commands.executeCommand = async (id, ...args) => {
    calls.push({ id, args, message: input.value });
    return { committed: false, queued: true };
  };
  input.setValue('Preserve while queued');
  await context.commit({ stopPropagation() {} });
  assert.equal(input.value, 'Preserve while queued', 'Queued commit keeps its original message');

  context.commands.executeCommand = async (id, ...args) => {
    calls.push({ id, args, message: input.value });
    input.setValue('Edited while committing');
    return { committed: true, queued: false };
  };
  await context.commit({ stopPropagation() {} });
  assert.equal(input.value, 'Edited while committing', 'An updated draft is never erased');

  context.settings.codexCommitContext = false;
  const countBefore = calls.length;
  input.setValue('');
  await context.commit({ stopPropagation() {} });
  assert.equal(calls.length, countBefore, 'Empty messages without context are blocked');
  assert.match(String(errors.at(-1)), /Enter a commit message/);
  context.settings.codexCoauthor = false;
  input.setValue('Disabled control');
  await context.commit({ stopPropagation() {} });
  assert.equal(calls.length, countBefore, 'Disabled co-author button cannot commit');
  console.log('Codex commit startup regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
