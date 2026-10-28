'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('const SCM_TOOLKIT_CODEX_COAUTHOR =');
const end = source.indexOf('// Named G4 pony entries', start);
assert(start >= 0 && end > start, 'Find the co-author formatter');
const sandbox = vm.createContext({});
vm.runInContext(source.slice(start, end) + '\nthis.appendCoauthor = scmToolkitWithCodexCoauthor;', sandbox);
const append = sandbox.appendCoauthor;
const defaultTrailer = 'Co-authored-by: Codex <noreply@openai.com>';
const configured = { codexCoauthorName: 'Contributor Bot', codexCoauthorEmail: '123+bot[bot]@users.noreply.github.com' };
const customTrailer = 'Co-authored-by: Contributor Bot <123+bot[bot]@users.noreply.github.com>';
assert.equal(append('Fix widget'), 'Fix widget\n\n' + defaultTrailer);
assert.equal(append('Fix widget\n\n' + defaultTrailer), 'Fix widget\n\n' + defaultTrailer);
assert.equal(append('Fix widget\r\n\r\n' + customTrailer, configured), 'Fix widget\r\n\r\n' + customTrailer);
assert.equal(append('Fix widget', configured), 'Fix widget\n\n' + customTrailer);
assert.equal(append('Fix widget\n\n' + defaultTrailer, configured),
  'Fix widget\n\n' + defaultTrailer + '\n\n' + customTrailer);
assert.equal(append('    ', configured), '');
for (const bad of [
  { codexCoauthorName: 'Broken\nCo-authored-by: Attack <evil@example.com>' },
  { codexCoauthorName: 'Bad <Name>' },
  { codexCoauthorName: '' },
  { codexCoauthorName: 'X'.repeat(101) },
  { codexCoauthorEmail: 'bad email@example.com' },
  { codexCoauthorEmail: 'invalid' },
  { codexCoauthorEmail: 'a@b\nNew trailer' }
]) {
  assert.throws(() => append('Commit', bad), /Invalid co-author/);
}
console.log('Configurable co-author trailer tests passed');
