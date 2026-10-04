'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
const executeGh = args => run(gh, args, { timeout: 120000 });

async function squashMergePullRequest(url, execute = executeGh) {
  const match = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/);
  if (!match) throw new Error('Select a GitHub pull request.');
  const repo = `${match[1]}/${match[2]}`;
  const number = match[3];
  const fields = 'state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository';
  const read = async () => JSON.parse((await execute(['pr', 'view', number, '--repo', repo, '--json', fields])).stdout);
  const pr = await read();
  if (pr.state !== 'OPEN' || pr.isDraft || pr.baseRefName !== 'main' || !/^[0-9a-f]{40}$/i.test(pr.headRefOid)) {
    throw new Error('Only open, ready-for-review pull requests targeting main can be squash-merged.');
  }
  await execute(['pr', 'merge', number, '--repo', repo, '--squash', '--match-head-commit', pr.headRefOid]);
  const merged = await read();
  // Merge queues can accept the request without having merged it yet.
  if (merged.state !== 'MERGED') return { merged: false, repo, number };
  if (merged.headRefOid !== pr.headRefOid || merged.baseRefName !== 'main') {
    throw new Error('The pull request changed during merging; branch cleanup was skipped.');
  }
  return { merged: true, repo, number, pr: merged };
}

async function deleteMergedRemoteBranch(result, execute = executeGh) {
  const { pr, repo } = result;
  if (!result.merged || pr.isCrossRepository || !pr.headRefName || pr.headRefName === 'main') return;
  const ref = `repos/${repo}/git/refs/heads/${pr.headRefName.split('/').map(encodeURIComponent).join('/')}`;
  const readRefs = async () => JSON.parse((await execute(['api', `repos/${repo}/git/matching-refs/heads/${pr.headRefName.split('/').map(encodeURIComponent).join('/')}`])).stdout);
  // The repository may already delete branches on merge. Check presence without
  // treating an already-deleted branch as a failure.
  const refs = await readRefs();
  const current = refs.find(candidate => candidate.ref === `refs/heads/${pr.headRefName}`);
  if (!current) return;
  if (current.object?.sha !== pr.headRefOid) throw new Error('Remote branch has new commits; it was preserved.');
  const open = JSON.parse((await execute(['pr', 'list', '--repo', repo, '--head', pr.headRefName,
    '--state', 'open', '--limit', '1', '--json', 'number'])).stdout);
  if (open.length) throw new Error('Remote branch is used by another open pull request; it was preserved.');
  try {
    await execute(['api', '--method', 'DELETE', ref]);
  } catch (error) {
    // GitHub's automatic deletion can race with the checks above. A 404 is
    // successful cleanup only when a fresh lookup confirms the exact ref is gone.
    if (/\bHTTP 404\b/.test(`${error.stderr || ''}\n${error.message || ''}`)) {
      const remaining = await readRefs();
      if (!remaining.some(candidate => candidate.ref === `refs/heads/${pr.headRefName}`)) return;
    }
    throw error;
  }
}

function registerGitHubPullRequestActions(vscode, context) {
  const busy = new Set();
  context.subscriptions.push(vscode.commands.registerCommand('scmToolkit.squashMergePullRequest', async node => {
    const model = node?.pullRequestModel;
    const url = model?.html_url;
    if (busy.has(url)) return;
    busy.add(url);
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Squash-merge PR #${model?.number ?? ''} into main`, cancellable: false
      }, () => squashMergePullRequest(url));
      if (!result.merged) {
        vscode.window.showInformationMessage(`PR #${result.number} is queued for merge. Branch cleanup will wait until it merges.`);
        return;
      }
      try {
        await deleteMergedRemoteBranch(result);
      } catch (error) {
        vscode.window.showWarningMessage(`PR #${result.number} merged, but remote branch cleanup failed: ${error.stderr?.trim() || error.message}`);
      }
      try {
        const extension = vscode.extensions.getExtension('vscode.git');
        const api = extension && (await extension.activate()).getAPI(1);
        const repository = api?.repositories.find(candidate => candidate.state.remotes.some(remote =>
          [remote.fetchUrl, remote.pushUrl].some(value => value &&
            require('./pull_request').githubRepository(value) === `https://github.com/${result.repo}`)));
        if (repository && !result.pr.isCrossRepository && result.pr.headRefName !== 'main') {
          const installed = path.join(__dirname, 'prune_merged_branches.py');
          const script = existsSync(installed) ? installed : path.join(__dirname, '../scripts/prune_merged_branches.py');
          await run(process.platform === 'win32' ? 'python' : 'python3', [script, '--force', '--repo',
            repository.rootUri.fsPath, `--branch=${result.pr.headRefName}`], { timeout: 120000 });
          await repository.status();
        }
      } catch (error) {
        vscode.window.showWarningMessage(`PR #${result.number} merged, but local branch cleanup failed: ${error.message}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to squash-merge pull request: ${error.stderr?.trim() || error.message}`);
    } finally {
      busy.delete(url);
      await vscode.commands.executeCommand('pr.refreshList').catch(() => {});
    }
  }));
}

module.exports = { squashMergePullRequest, deleteMergedRemoteBranch, registerGitHubPullRequestActions };
