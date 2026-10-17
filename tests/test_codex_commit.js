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
  assert.equal(calls[0].id, 'sweetiebot.queueCommit');
  assert.equal(calls[0].args[0], context.currentRepositoryUri);
  assert.equal(calls[0].args[1].message, 'Fix button');
  assert.equal(calls[0].args[1].trailer, 'Co-authored-by: Codex <noreply@openai.com>');
  assert.equal(calls[0].args[1].push, true);
  assert.equal(input.value, 'Fix button', 'queueing does not overwrite the input');
  assert.deepEqual(errors, []);
  calls.length = 0;
  input.setValue('');
  context.settings.codexCommitContext = true;
  await context.commit({ stopPropagation() {} });
  assert.deepEqual(calls.map(call => call.id), ['sweetiebot.queueCommit']);
  assert.equal(calls[0].args[1].message, '');
  assert.equal(calls[0].args[1].codex, true, 'generation and context belong to the durable job');
  assert.equal(input.value, '');
  context.commands.executeCommand = async () => { throw new Error('Queue failed'); };
  await context.commit({ stopPropagation() {} });
  assert.equal(errors.at(-1).message, 'Queue failed');
  assert.equal(context.codexButton.disabled, false);

  // The default direct path commits synchronously and preserves custom attribution.
  context.durable = false;
  context.commands.executeCommand = async (id, ...args) => {
    calls.push({ id, args, message: input.value });
    if (id === 'sweetiebot.generateCodexCommitMessage') return '🧪 Document captured changes';
  };
  calls.length = 0;
  input.setValue('Fast explicit subject');
  await context.commit({ stopPropagation() {} });
  assert.deepEqual(calls.map(call => call.id), ['sweetiebot.commitWithMessage']);
  assert.match(calls[0].args[1], /Fast explicit subject/);
  assert.match(calls[0].args[1], /Co-authored-by: Codex/);
  assert.equal(input.value, '', 'Direct commit clears only the unchanged input');
  calls.length = 0;
  input.setValue('');
  await context.commit({ stopPropagation() {} });
  assert.deepEqual(calls.map(call => call.id), [
    'sweetiebot.generateCodexCommitMessage', 'sweetiebot.commitWithMessage'
  ]);
  assert.match(calls[1].args[1], /Document captured changes/);
  console.log('Codex commit startup regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
