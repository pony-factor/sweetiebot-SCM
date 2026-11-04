'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'check.yml'), 'utf8');
assert.match(workflow, /^  push:\s*$/m, 'Checks must run on head-branch pushes');
const matches = [...workflow.matchAll(/^concurrency:\s*$/gm)];
assert.equal(matches.length, 1, 'Checks must have one top-level concurrency block');
const concurrency = workflow.slice(matches[0].index).split(/^permissions:\s*$/m)[0];
assert.match(concurrency, /^  group: \$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}\s*$/m);
assert.match(concurrency, /^  cancel-in-progress: true\s*$/m);
console.log('Head-branch workflow cancellation regression checks passed.');
