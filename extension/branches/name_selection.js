'use strict';

const { execFile } = require('node:child_process');
const { randomInt, randomUUID } = require('node:crypto');
const { readFile, writeFile, rename, rm } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const HISTORY_FILENAME = 'sweetiebot-branch-name-history.json';

async function loadBranchNameHistory(repository) {
  const root = repository.rootUri?.fsPath;
  if (!root) return { file: null, selected: [] };
  // Git's common directory is shared by linked worktrees and is never committed.
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-common-dir'], {
    cwd: root, timeout: 10000
  });
  const commonDir = stdout.trim();
  if (!commonDir) throw new Error('Could not locate the Git directory for pony branch history.');
  const file = path.join(path.resolve(root, commonDir), HISTORY_FILENAME);
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file, selected: [] };
    throw error;
  }
  let history;
  try {
    history = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid pony branch history in ${file}; repair or remove the file to reset it.`);
  }
  if (history?.version !== 1 || !Array.isArray(history.selected)
      || !history.selected.every(name => typeof name === 'string')) {
    throw new Error(`Invalid pony branch history in ${file}; repair or remove the file to reset it.`);
  }
  return { file, selected: history.selected };
}

function chooseBranchName(available, selected, secureRandomInt = randomInt) {
  if (!available.length) throw new Error('No available pony branch names.');
  const prior = [...new Set(selected)];
  // Only names not yet drawn this cycle are eligible, even if an old branch was deleted.
  const remaining = available.filter(name => !prior.includes(name));
  if (remaining.length) {
    const branch = remaining[secureRandomInt(remaining.length)];
    return { branch, selected: [...prior, branch] };
  }
  // Start the next cycle, but don't immediately repeat the previous draw when possible.
  const last = prior.at(-1);
  const choices = available.length > 1 ? available.filter(name => name !== last) : available;
  const branch = choices[secureRandomInt(choices.length)];
  return { branch, selected: [branch] };
}

async function saveBranchNameHistory(file, selected) {
  if (!file) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, selected }), {
      encoding: 'utf8', flag: 'wx'
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

module.exports = { loadBranchNameHistory, chooseBranchName, saveBranchNameHistory };
