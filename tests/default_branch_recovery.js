const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('            const resolveBase = async () => {');
const end = source.indexOf('            void resolveBase();', start) + '            void resolveBase();'.length;
const script = source.slice(start, end).replace('void resolveBase();', 'resolveBase();');
(async () => {
 for (const first of [undefined, new Error('extension not ready')]) {
  let attempts = 0, retry, refresh = 0, errors = 0;
  const context = { commands: { executeCommand: async () => { if (++attempts === 1) { if (first instanceof Error) throw first; return first; } return 'main'; } }, provider: { rootUri: {} }, settings: { remote: 'origin' }, repositoryResolveToken: 1, resolutionToken: 1, notifications: { error: () => errors++ }, setTimeout: callback => { retry = callback; }, refreshBranchControls: () => refresh++, widget: { layout() {} } };
  vm.createContext(context);
  await vm.runInContext(script, context);
  assert.equal(errors, 1); assert.equal(refresh, 0); assert.ok(retry);
  await retry(); assert.equal(context.currentDefaultBranch, 'main'); assert.equal(refresh, 1);
  context.repositoryResolveToken = 2;
  await retry(); assert.equal(refresh, 1, 'ignore stale repository result');
 }
 console.log('Default branch recovery: empty result, rejection, retry, and stale result passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
