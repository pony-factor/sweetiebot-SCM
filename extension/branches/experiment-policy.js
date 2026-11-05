'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function isExperimentWorkspace(root) {
  if (!root) return false;
  try {
    // Resolve macOS /var aliases and symlinked folder entries. The marker lives
    // beside the checkout, so it survives branch switches and Git resets.
    const repository = await fs.realpath(root);
    const marker = path.join(path.dirname(repository), '.sweetiebot-experiment.json');
    return (await fs.lstat(marker)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function deferExperimentPublish(root) {
  if (!await isExperimentWorkspace(root)) return false;
  const repository = await fs.realpath(root);
  const marker = path.join(path.dirname(repository), '.sweetiebot-experiment.json');
  const snapshot = JSON.parse(await fs.readFile(marker, 'utf8'));
  // Missing baseline metadata cannot establish that a trial has a new commit.
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.head || '')) return true;
  const git = async args => (await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
  const head = await git(['rev-parse', 'HEAD']);
  if (head === snapshot.head) return true;
  try {
    await git(['merge-base', '--is-ancestor', snapshot.head, head]);
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

module.exports = { isExperimentWorkspace, deferExperimentPublish };
