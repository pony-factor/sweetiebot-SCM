'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflows = path.join(__dirname, '../..', '.github', 'workflows');
const workflow = fs.readFileSync(path.join(workflows, 'check.yml'), 'utf8');
const codexCompatibility = fs.readFileSync(path.join(workflows, 'codex-queue-compatibility.yml'), 'utf8');

assert.doesNotMatch(workflow, /^  push:\s*$/m, 'Merges to main must not repeat the PR suite');
assert.match(workflow, /^  pull_request:\s*$/m, 'Pull request updates must run Checks');
assert.match(workflow, /^  workflow_dispatch:\s*$/m, 'Maintainers must be able to run Checks manually');

const matches = [...workflow.matchAll(/^concurrency:\s*$/gm)];
assert.equal(matches.length, 1, 'Checks must have one top-level concurrency block');
const concurrency = workflow.slice(matches[0].index).split(/^permissions:\s*$/m)[0];
const group = concurrency.match(/^  group: (.+)$/m)?.[1];
assert.equal(
  group,
  "${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('manual-{0}', github.run_id) }}",
  'PR runs must share a per-PR group, while manual runs remain independent'
);
const cancellation = concurrency.match(/^  cancel-in-progress: (.+)$/m)?.[1];
assert.equal(cancellation, "${{ github.event_name == 'pull_request' }}", 'Only older PR checks can be cancelled');

assert.doesNotMatch(workflow, /^  codex-queue-release-compatibility:\s*$/m, 'External Codex release checks must not run for every PR');
assert.match(codexCompatibility, /^  workflow_call:\s*$/m, 'Release compatibility must remain callable');
assert.match(codexCompatibility, /^  workflow_dispatch:\s*$/m, 'Release compatibility must remain manually runnable');
assert.match(codexCompatibility, /^    - cron: ['"]23 10 \* \* 1['"]$/m, 'Release compatibility must run weekly on Monday');

const requiredJobs = [
  'python-compatibility',
  'inventory',
  'coreml-bridge',
  'suites',
  'worktree-window-handoff',
  'worktree-shutdown-safety',
  'codex-webview-browser',
  'bot-app-identities',
  'packaged-runtime',
  'macos-functionality',
  'macos-native-prompt-transport',
  'native-prompt-transport',
];
for (const job of requiredJobs) {
  assert.ok(workflow.includes('  ' + job + ':\n'), 'Required job must exist: ' + job);
}
const gate = workflow.split(/^  required-checks:\s*$/m)[1];
assert.ok(gate, 'The stable required-checks job must exist');
assert.match(gate, /^    name: Required CI checks$/m, 'Branch protection needs a stable check name');
assert.match(gate, /^    if: $\{\{ always\(\) \}\}$/m, 'Gate must report failures even if upstream jobs fail');
const dependencies = gate.match(/^    needs:\n((?:      - [a-z][a-z0-9-]*\n)+)/m)?.[1];
assert.ok(dependencies, 'The gate must explicitly depend on the required jobs');
const actualJobs = [...dependencies.matchAll(/^      - ([a-z][a-z0-9-]*)$/gm)].map(match => match[1]);
assert.deepEqual(actualJobs.sort(), [...requiredJobs].sort(), 'All required jobs must feed the gate');
assert.ok(gate.includes('JOB_RESULTS: ${{ toJSON(needs) }}'), 'The gate must inspect every dependency result');
assert.match(gate, /result != "success"/, 'Skipped, cancelled, and failed dependencies must fail the gate');

console.log('PR-only Checks, weekly Codex compatibility, and aggregate CI gate regression checks passed.');
