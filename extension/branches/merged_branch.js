'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolvePythonExecutable } = require('../ui/python_runtime');

async function mergedBranchAction(repository, ...args) {
  const script = existsSync(path.join(__dirname, '../merged_branch.py'))
    ? path.join(__dirname, '../merged_branch.py') : path.join(__dirname, '../../scripts/merged_branch.py');
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
  const action = `Continue on new branch from ${info.branch}`;
  const choice = await vscode.window.showWarningMessage(
    `Branch "${info.branch}" was merged in PR #${info.number}. Publishing to it is blocked.`,
    { modal: true, detail: `Your local commits are preserved. Continue from the current local tip of "${info.branch}", without fetching, merging, or rebasing onto ${info.defaultBranch || 'main'}.` },
    action
  );
  if (choice !== action) return false;
  return vscode.commands.executeCommand('sweetiebot.createBranch', repository.rootUri, {
    remote: info.remote, continueFromBranch: info.branch
  });
}

module.exports = { mergedBranchAction, mergedBranchStatus, warnMergedBranch };
