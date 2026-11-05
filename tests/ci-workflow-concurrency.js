'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'check.yml'), 'utf8');
assert.match(workflow, /^  push:\s*\n    branches: \[main\]\s*$/m, 'Main pushes must run Checks');
assert.match(workflow, /^  pull_request:\s*$/m, 'Pull request updates must run Checks');
const matches = [...workflow.matchAll(/^concurrency:\s*$/gm)];
assert.equal(matches.length, 1, 'Checks must have one top-level concurrency block');
const concurrency = workflow.slice(matches[0].index).split(/^permissions:\s*$/m)[0];
assert.match(concurrency, /^  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('main-\{0\}-\{1\}', github\.run_id, github\.run_attempt\) \}\}$/m, 'PRs share a per-PR group; main runs remain independent');
assert.match(concurrency, /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m, 'Only older PR checks can be cancelled');
console.log('Main and PR workflow concurrency regression checks passed.');
