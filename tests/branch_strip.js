'use strict';

const assert = require('node:assert/strict');
const { groupBranchRefs, parseGitHubRemote } = require('../extension/branches/strip');

assert.equal(parseGitHubRemote('git@github.com:pony-factor/sweetiebot-SCM.git'),
  'github.com/pony-factor/sweetiebot-SCM');
assert.equal(parseGitHubRemote('https://github.com/pony-factor/sweetiebot-SCM.git'),
  'github.com/pony-factor/sweetiebot-SCM');
assert.equal(parseGitHubRemote('file:///tmp/repository'), null);

const refs = [
  'refs/heads/main\t3',
  'refs/heads/working\t100',
  'refs/remotes/origin/working\t80',
  'refs/remotes/origin/remote-only\t90',
  'refs/heads/has-pr\t140',
  'refs/heads/merged\t60',
  'refs/remotes/origin/HEAD\t200',
  'refs/heads/older\t10',
  'refs/remotes/origin/older\t5'
].join('\n');
const merged = 'refs/heads/merged\nrefs/heads/main\nrefs/remotes/origin/older';
const result = groupBranchRefs(refs, merged, new Set(['has-pr']), true, 'main');
assert.equal(result.featuredCount, 3);
assert.deepEqual(result.branches.slice(0, 3).map(item => item.name),
  ['working', 'older', 'remote-only']);
assert.deepEqual(result.branches.map(item => item.name).sort(),
  ['has-pr', 'main', 'merged', 'older', 'remote-only', 'working']);
assert.deepEqual(result.branches.find(item => item.name === 'working'),
  { name: 'working', local: true, origin: true, merged: false, modified: 100,
    hasPr: false, featured: true });
assert.equal(result.branches.find(item => item.name === 'remote-only').origin, true);
assert.equal(result.branches.find(item => item.name === 'has-pr').featured, false);
assert.equal(result.branches.find(item => item.name === 'merged').featured, false);
// Remote may have merged while a local branch still contains unmerged commits.
assert.equal(result.branches.find(item => item.name === 'older').merged, false);
assert.equal(result.branches.find(item => item.name === 'main').featured, false);
const withPrDetails = groupBranchRefs(refs, merged, new Map([['has-pr', {
  number: 25, url: 'https://github.com/pony-factor/sweetiebot-SCM/pull/25', state: 'OPEN'
}]]), true, 'main');
assert.deepEqual(withPrDetails.branches.find(item => item.name === 'has-pr').pr, {
  number: 25, url: 'https://github.com/pony-factor/sweetiebot-SCM/pull/25', state: 'OPEN'
});
assert.equal(withPrDetails.branches.find(item => item.name === 'working').hasPr, false);
const unknown = groupBranchRefs(refs, merged, new Set(), false, 'main');
assert.equal(unknown.featuredCount, 0);
assert(unknown.branches.every(item => item.hasPr === null));
console.log('branch strip grouping tests passed');
