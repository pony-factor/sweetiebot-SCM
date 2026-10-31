'use strict';

const { setTimeout: pause } = require('node:timers/promises');
const { releaseClosedWorktree } = require('./workspace_prune');

// Survive VS Code shutdown and allow a fresh window/reload to renew ownership.
async function run(groups, { wait = pause, release = releaseClosedWorktree } = {}) {
  if (!groups.length) return;
  await wait(120000);
  for (const group of [...new Set(groups)]) {
    try { await release(group); }
    catch (error) { console.warn('Preserved closed worktree:', error.message); }
  }
}

if (require.main === module) {
  void run(process.argv.slice(2)).catch(error => {
    console.error('Closed-worktree cleanup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { run };
