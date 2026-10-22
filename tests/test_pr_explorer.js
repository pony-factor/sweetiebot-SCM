'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('function scmToolkitIsSingleRoot(');
const end = source.indexOf('\n}\n', start);
assert.ok(start >= 0 && end > start, 'Single-root workspace predicate must be shipped');
const isSingleRoot = vm.runInNewContext(
    source.slice(start, end + 2) + '\nscmToolkitIsSingleRoot'
);

const workspace = fsPath => ({
    configuration: { scheme: 'file', fsPath }
});
const file = '/Users/example/project/.git/sweetiebot-pr-sessions/session-abc123/Draft PR [project].code-workspace';
assert.equal(isSingleRoot(workspace(file), [{}]), true, 'PR Explorer should display repository contents directly');
assert.equal(isSingleRoot(workspace(file), [{}, {}]), false, 'Multi-root sessions still show root folders');
assert.equal(isSingleRoot(workspace(file), [{ error: new Error('missing root') }]), false, 'Missing roots keep native error rendering');
assert.equal(isSingleRoot(workspace(file), []), false, 'Empty workspaces retain their own Explorer state');
assert.equal(isSingleRoot(workspace('/Users/example/project.code-workspace'), [{}]), true, 'Normal saved workspaces show contents directly');
assert.equal(isSingleRoot(workspace('/Users/example/project/pr-sessions/session-abc123/Draft PR [project].code-workspace'), [{}]), true, 'Single-folder saved workspaces show contents directly');
assert.equal(isSingleRoot({ configuration: { scheme: 'vscode-remote', fsPath: file } }, [{}]), true, 'Remote single-folder workspaces show contents directly');
assert.equal(isSingleRoot({}, [{}]), true, 'Unnamed single-folder workspaces show contents directly');
assert.equal(isSingleRoot({}, [null]), false, 'Invalid roots retain native handling');
console.log('Explorer single-root workspace guards passed.');
