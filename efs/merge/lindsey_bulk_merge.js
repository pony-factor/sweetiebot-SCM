'use strict';

const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { lindseyScript } = require('./lindsey_conflicts');
const { separateAppsEnabled, stripAppSecrets, getRoleInstallationToken } = require('../github/github_app_identity');

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const statuses = new Set(['merged', 'queued', 'blocked', 'verification-failed']);

function findBulkMergeScript(root, folders = []) {
  try {
    const resolver = lindseyScript(root, folders);
    const script = path.join(path.dirname(resolver), 'bulk-merge.js');
    return existsSync(script) ? script : undefined;
  } catch {
    return undefined;
  }
}

function bulkMergeSelection(repository, pulls) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !Array.isArray(pulls) || pulls.length < 1 || pulls.length > 50 ||
      pulls.some(pr => !Number.isSafeInteger(pr.number) || pr.number < 1 ||
        !SHA.test(pr.headSha || '') || !pr.base || !pr.head || !pr.title)) {
    throw new Error('Lindsey requires 1–50 PRs with current GitHub head SHAs');
  }
  if (new Set(pulls.map(pr => pr.number)).size !== pulls.length) {
    throw new Error('Duplicate PR number in Lindsey selection');
  }
  return {
    repository,
    pullRequests: pulls.map(pr => ({
      number: pr.number, title: pr.title, head: pr.head,
      base: pr.base, headSha: pr.headSha, headRepo: pr.headRepo,
      stack: Boolean(pr.stack)
    }))
  };
}

function validateResult(result, selection) {
  const expected = new Set(selection.pullRequests.map(pr => pr.number));
  if (result?.version !== 1 || result.repository !== selection.repository ||
      !Array.isArray(result.results) || result.results.length !== expected.size) {
    throw new Error('Lindsey returned an incomplete bulk-merge report');
  }
  for (const entry of result.results) {
    if (!expected.delete(entry?.number) || !statuses.has(entry.status)) {
      throw new Error('Lindsey returned an unexpected PR or result status');
    }
  }
  return result;
}

async function invokeLindseyBulkMerge(script, selection, token, runner = exec,
  { env = process.env, roleToken = getRoleInstallationToken } = {}) {
  const appToken = separateAppsEnabled(env)
    ? (await roleToken('lindsey', selection.repository, { env })).token : token;
  if (typeof appToken !== 'string' || !appToken) throw new Error('Lindsey GitHub authentication is unavailable.');
  const childEnv = stripAppSecrets(env);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-lindsey-merge-'));
  try {
    const input = path.join(temporary, 'selection.json');
    await fs.writeFile(input, JSON.stringify(selection), { mode: 0o600 });
    // Finder-launched VS Code may omit Homebrew from its inherited PATH.
    const executablePath = process.platform === 'darwin'
      ? [...new Set([...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter)
      : process.env.PATH;
    const { stdout } = await runner(process.execPath, [script, '--input', input], {
      timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
      env: { ...childEnv, PATH: executablePath, GH_TOKEN: appToken,
        GITHUB_TOKEN: appToken, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }
    });
    return validateResult(JSON.parse(stdout), selection);
  } finally {
    await fs.rm(temporary, { force: true, recursive: true });
  }
}

async function runBulkMergeWithLindsey(vscode, script, repo, pulls, token,
  invoke = invokeLindseyBulkMerge) {
  const selection = bulkMergeSelection(repo, pulls);
  const execute = () => invoke(script, selection, token);
  const result = typeof vscode.window.withProgress === 'function'
    ? await vscode.window.withProgress({
      location: vscode.ProgressLocation?.Notification || 15,
      title: 'Lindsey: verifying and squash-merging selected PRs',
      cancellable: false
    }, execute)
    : await execute();
  validateResult(result, selection);
  const output = vscode.window.createOutputChannel?.('Lindsey Bulk Merge');
  if (output) {
    output.appendLine('Repository: ' + repo);
    for (const entry of result.results) {
      output.appendLine('#' + entry.number + ' [' + entry.status + '] → ' + entry.base +
        (entry.url ? ' — ' + entry.url : '') + (entry.reason ? ' — ' + entry.reason : ''));
    }
    output.show(true);
  }
  const merged = result.results.filter(pr => pr.status === 'merged').length;
  const queued = result.results.filter(pr => pr.status === 'queued').length;
  const blocked = result.results.length - merged - queued;
  const message = 'Lindsey bulk merge: ' + merged + ' merged, ' + queued +
    ' queued, ' + blocked + ' blocked or unverified. See Lindsey Bulk Merge output.';
  if (blocked) vscode.window.showWarningMessage(message);
  else vscode.window.showInformationMessage(message);
  return result;
}

module.exports = { findBulkMergeScript, bulkMergeSelection, validateResult,
  invokeLindseyBulkMerge, runBulkMergeWithLindsey };
