'use strict';

const path = require('node:path');

function worktreeEntries(porcelain) {
  const value = String(porcelain || '');
  const nul = value.includes('\0');
  return value.split(nul ? '\0\0' : /\r?\n\r?\n/)
    .map(block => block.split(nul ? '\0' : /\r?\n/));
}

function worktreePaths(porcelain) {
  return worktreeEntries(porcelain)
    .map(lines => lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length))
    .filter(directory => directory && path.isAbsolute(directory));
}

// Build a fresh branch -> checkout-path map from Git's authoritative registry.
// Do not cache paths across operations: other windows can add/remove worktrees.
function worktreeLocations(porcelain) {
  const locations = new Map();
  for (const lines of worktreeEntries(porcelain)) {
    const branch = lines.find(line => line.startsWith('branch refs/heads/'))
      ?.slice('branch refs/heads/'.length);
    const directory = lines.find(line => line.startsWith('worktree '))
      ?.slice('worktree '.length);
    if (!branch || !directory || !path.isAbsolute(directory)) continue;
    locations.set(branch, directory);
  }
  return locations;
}

module.exports = { worktreeLocations, worktreePaths };
