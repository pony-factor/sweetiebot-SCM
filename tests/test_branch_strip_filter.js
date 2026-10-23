'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate the workbench source without requiring a VS Code UI.
const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/branch_strip.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const filter = context.scmToolkitFilterBranchStrip;
const sortRecent = context.scmToolkitSortBranchStrip;
assert.equal(typeof filter, 'function');
assert.equal(typeof sortRecent, 'function');

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
