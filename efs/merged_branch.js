'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolvePythonExecutable } = require('./python_runtime');

async function mergedBranchAction(repository, ...args) {
  const script = existsSync(path.join(__dirname, 'merged_branch.py'))
    ? path.join(__dirname, 'merged_branch.py') : path.join(__dirname, '../scripts/merged_branch.py');
  const { stdout } = await promisify(execFile)(resolvePythonExecutable(), [script, ...args], {
    cwd: repository.rootUri.fsPath, timeout: 120000
  });
  return JSON.parse(stdout);
}

async function mergedBranchStatus(repository, remote = 'origin', branch = '') {
  if (!repository.rootUri?.fsPath || !existsSync(path.join(repository.rootUri.fsPath, '.git'))) return null;
  return mergedBranchAction(repository, '--status', branch, remote);
}

async function warnMergedBranch(vscode, repository, info) {
  const action = `New branch from updated ${info.defaultBranch}`;
  const choice = await vscode.window.showWarningMessage(
    `Branch "${info.branch}" was merged in PR #${info.number}. Pushing would recreate or update that merged branch.`,
    { modal: true, detail: 'Your local commits are preserved. Start a fresh branch with only the follow-up changes.' },
    action
  );
  if (choice === action) {
    await vscode.commands.executeCommand('sweetiebot.createBranch', repository.rootUri, { remote: info.remote });
  }
  return false;
}

module.exports = { mergedBranchAction, mergedBranchStatus, warnMergedBranch };
