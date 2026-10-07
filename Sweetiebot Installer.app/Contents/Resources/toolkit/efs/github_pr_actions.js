'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pullRequestFromTreeNode } = require('./github_pr_refresh');
const { promisify } = require('node:util');

const run = promisify(execFile);
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
const executeGh = args => run(gh, args, { timeout: 120000 });

async function squashMergePullRequest(url, execute = executeGh) {
  const match = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/);
  if (!match) throw new Error('Could not identify the pull request. Refresh the GitHub Pull Requests view and use the merge button on its PR row.');
  const repo = `${match[1]}/${match[2]}`;
  const number = match[3];
  const fields = 'state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable';
  const read = async () => JSON.parse((await execute(['pr', 'view', number, '--repo', repo, '--json', fields])).stdout);
  const pr = await read();
  if (pr.state !== 'OPEN' || pr.isDraft || pr.baseRefName !== 'main' || !/^[0-9a-f]{40}$/i.test(pr.headRefOid)) {
    throw new Error('Only open, ready-for-review pull requests targeting main can be squash-merged.');
  }
  const conflict = () => Object.assign(
    new Error(`Unable to merge #${number}: conflicts with \`${pr.baseRefName}\``),
    { code: 'SWEETIEBOT_MERGE_CONFLICT' }
  );
  if (pr.mergeable === 'CONFLICTING') throw conflict();
  try {
    await execute(['pr', 'merge', number, '--repo', repo, '--squash', '--match-head-commit', pr.headRefOid]);
  } catch (error) {
    // Mergeability can change after the first read, or initially be UNKNOWN.
    const latest = await read().catch(() => undefined);
    if (latest?.mergeable === 'CONFLICTING') throw conflict();
    throw error;
  }
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
    // GitHub's automatic deletion can race with the checks above. Missing refs
    // can return 404 or "Reference does not exist" (422); confirm the exact ref
    // is gone before treating either response as successful cleanup.
    const detail = `${error.stderr || ''}\n${error.message || ''}`;
    if (/\bHTTP 404\b/.test(detail) ||
        (/\bHTTP 422\b/.test(detail) && /\bReference does not exist\b/i.test(detail))) {
      const remaining = await readRefs();
      if (!remaining.some(candidate => candidate.ref === `refs/heads/${pr.headRefName}`)) return;
    }
    throw error;
  }
}

function registerGitHubPullRequestActions(vscode, context, merge = squashMergePullRequest) {
  const busy = new Set();
  const handler = async node => {
    const model = pullRequestFromTreeNode(node);
    const url = model.url;
    if (busy.has(url)) return;
    busy.add(url);
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Squash-merge PR #${model?.number ?? ''} into main`, cancellable: false
      }, () => merge(url));
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
      const detail = error.stderr?.trim() || error.message;
      vscode.window.showErrorMessage(
        error.code === 'SWEETIEBOT_MERGE_CONFLICT'
          ? error.message
          : `Unable to squash-merge pull request: ${detail}`
      );
    } finally {
      busy.delete(url);
      await vscode.commands.executeCommand('pr.refreshList').catch(() => {});
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.squashMergePullRequest', handler),
    vscode.commands.registerCommand('sweetiebot.squashMergeSelectedPullRequest', async node => {
      // The optional GitHub tree patch can resolve selection and rendered items.
      // Keep direct PR arguments working when that extension is unavailable.
      const resolver = 'sweetiebot.resolveSelectedPullRequest';
      const commands = await vscode.commands.getCommands(true);
      const model = commands.includes(resolver)
        ? await vscode.commands.executeCommand(resolver, node)
        : node;
      return handler(model);
    })
  );
}

module.exports = { squashMergePullRequest, deleteMergedRemoteBranch, registerGitHubPullRequestActions };
