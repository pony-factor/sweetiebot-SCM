'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate the workbench source without requiring a VS Code UI.
const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/branch-strip.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const filter = context.scmToolkitFilterBranchStrip;
const sortRecent = context.scmToolkitSortBranchStrip;
const sameSnapshot = context.scmToolkitBranchStripSameSnapshot;
const prLabel = context.scmToolkitBranchStripPrLabel;
assert.equal(typeof filter, 'function');
assert.equal(typeof sortRecent, 'function');
assert.equal(typeof sameSnapshot, 'function');
assert.equal(prLabel({ number: 648 }), '#648');
assert.equal(prLabel({ number: 297 }), '#297');
assert.equal(prLabel(), 'PR');

// Repeated remote refreshes must not replace identical PR rows and make their
// pills flicker, but real PR, origin, or status changes must repaint the list.
const verified = {
    branches: [{ name: 'feature', local: true, origin: true, hasPr: true,
        pr: { number: 648, state: 'OPEN' }, featured: false }],
    featuredCount: 0, prStatus: 'available', remoteStatus: 'available'
};
assert.equal(sameSnapshot(verified.branches, 0, 'available', 'available', verified), true);
assert.equal(sameSnapshot(verified.branches, 0, 'available', 'available',
    { ...verified, branches: verified.branches.map(item => ({ ...item,
        pr: { number: 649, state: 'OPEN' } })) }), false,
'Changed PR number must repaint');
assert.equal(sameSnapshot(verified.branches, 0, 'available', 'available',
    { ...verified, branches: verified.branches.map(item => ({ ...item, origin: false })) }), false,
'Deleted remote must remove its cloud badge');
assert.equal(sameSnapshot(verified.branches, 0, 'available', 'available',
    { ...verified, prStatus: 'unavailable' }), false,
'Unverified PR status must update');
assert.equal(sameSnapshot(verified.branches, 0, 'available', 'available',
    { ...verified, branches: [] }), false,
'Removed branch must not remain in the view');

const branches = [
    { name: 'main' },
    { name: 'feature/green' },
    { name: 'feature/Blue' },
    { name: 'fix/blue-edge' },
    { name: 'blue-maintenance' },
    { name: 'feature/a+b' }
];
const originalNames = branches.map(item => item.name);
const matches = filter(branches, 3, '  BLUE  ');
assert.deepEqual(Array.from(matches.branches, item => item.name),
    ['feature/Blue', 'fix/blue-edge', 'blue-maintenance']);
assert.equal(matches.featuredCount, 1, 'Count only matching featured branches');
assert.deepEqual(Array.from(filter(branches, 3, '+').branches, item => item.name),
    ['feature/a+b'], 'Treat search text as literal substring');
assert.equal(filter(branches, 3, 'missing').branches.length, 0);
assert.equal(filter(branches, 3, 'missing').featuredCount, 0);
const all = filter(branches, 3, '');
assert.equal(all.branches, branches, 'Clearing search restores the cached list');
assert.equal(all.featuredCount, 3);
assert.deepEqual(branches.map(item => item.name), originalNames, 'Filtering never mutates the cache');
const visits = { 'feature/green': 500, 'main': 1000, 'feature/Blue': 200 };
const byRecent = sortRecent([
    { name: 'feature/Blue', modified: 20000 },
    { name: 'feature/green', modified: 2 },
    { name: 'main', modified: 1 },
    { name: 'new-unvisited', modified: 30000 }
], visits);
assert.deepEqual(Array.from(byRecent, item => item.name),
    ['main', 'feature/green', 'feature/Blue', 'new-unvisited'],
    'Use recency before commit dates, then keep unvisited branches in commit order');
assert.equal(byRecent[0].name, 'main');
console.log('branch strip type-to-filter and recent-order tests passed');
