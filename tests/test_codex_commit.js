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
    scmToolkitWithCodexCoauthor: message => `${message}\n\nCo-authored-by: Codex <noreply@openai.com>`,
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
  assert.equal(calls[0].id, 'sweetiebot.prepareCodexCommit');
  assert.equal(calls[1].id, 'sweetiebot.commitWithMessage');
  assert.equal(calls[1].args[0], context.currentRepositoryUri);
  assert.match(calls[1].args[1], /Co-authored-by: Codex <noreply@openai.com>/);
  assert.equal(calls[1].message, 'Fix button', 'attribution never enters the SCM field');
  assert.equal(input.value, 'Fix button');
  assert.equal(context.codexButton.disabled, false);
  assert.deepEqual(errors, []);
  calls.length = 0;
  input.setValue('');
  context.settings.codexCommitContext = true;
  context.commands.executeCommand = async (id, ...args) => {
    calls.push({ id, args, message: input.value });
    if (id === 'sweetiebot.generateCodexCommitMessage') return 'Fix local commit generation';
  };
  await context.commit({ stopPropagation() {} });
  assert.deepEqual(calls.map(call => call.id), ['sweetiebot.prepareCodexCommit', 'sweetiebot.generateCodexCommitMessage', 'sweetiebot.commitWithMessage']);
  assert.match(calls[2].args[1], /^Fix local commit generation\n\nCo-authored-by: Codex/);
  assert(calls.every(call => call.message === ''), 'generated text never appears in the SCM field');
  assert.equal(input.value, '');
  calls.length = 0;
  context.commands.executeCommand = async (id, ...args) => {
    calls.push({ id, args, message: input.value });
    if (id === 'sweetiebot.generateCodexCommitMessage') return 'Generated message';
    if (id === 'sweetiebot.commitWithMessage') throw new Error('Commit failed');
  };
  await context.commit({ stopPropagation() {} });
  assert.equal(input.value, '', 'failed commits leave the SCM field empty');
  assert(calls.every(call => call.message === ''));
  calls.length = 0;
  context.commands.executeCommand = async id => {
    calls.push({ id });
    throw new Error('Ollama is offline');
  };
  await context.commit({ stopPropagation() {} });
  assert.equal(calls.length, 1, 'failed generation never dispatches a commit');
  assert.equal(input.value, '');
  assert.equal(context.codexButton.disabled, false);
  calls.length = 0;
  context.commands.executeCommand = async id => {
    calls.push({ id });
    if (id === 'sweetiebot.prepareCodexCommit') return;
    input.setValue('A newer manual message');
    return 'Generated message';
  };
  await context.commit({ stopPropagation() {} });
  assert.equal(calls.length, 2, 'editing the message while generating stops the commit');
  assert.equal(input.value, 'A newer manual message');
  console.log('Codex commit startup regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
