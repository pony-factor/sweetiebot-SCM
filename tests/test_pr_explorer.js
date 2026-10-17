'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('function scmToolkitIsPRSingleRoot(');
const end = source.indexOf('\n}\n', start);
assert.ok(start >= 0 && end > start, 'Dedicated PR workspace predicate must be shipped');
const isPRRoot = vm.runInNewContext(
    source.slice(start, end + 2) + '\nscmToolkitIsPRSingleRoot'
);

const workspace = fsPath => ({
    configuration: { scheme: 'file', fsPath }
});
const file = '/Users/example/project/.git/sweetiebot-pr-sessions/session-abc123/Draft PR [project].code-workspace';
assert.equal(isPRRoot(workspace(file), [{}]), true, 'PR Explorer should display repository contents directly');
assert.equal(isPRRoot(workspace(file), [{}, {}]), false, 'Multi-root sessions still show root folders');
assert.equal(isPRRoot(workspace(file), [{ error: new Error('missing root') }]), false, 'Missing roots keep native error rendering');
assert.equal(isPRRoot(workspace(file), []), false, 'Empty workspaces retain their own Explorer state');
assert.equal(isPRRoot(workspace('/Users/example/project.code-workspace'), [{}]), false, 'Normal saved workspaces are unchanged');
assert.equal(isPRRoot(workspace('/Users/example/project/pr-sessions/session-abc123/Draft PR [project].code-workspace'), [{}]), false, 'Unmanaged workspaces are unchanged');
assert.equal(isPRRoot({ configuration: { scheme: 'vscode-remote', fsPath: file } }, [{}]), false, 'Remote workspaces are unchanged');
assert.equal(isPRRoot({}, [{}]), false, 'Unnamed workspaces are unchanged');
console.log('PR Explorer single-root workspace guards passed.');
