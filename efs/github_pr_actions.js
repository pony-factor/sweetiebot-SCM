'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pullRequestFromTreeNode } = require('./github_pr_refresh');
const { squashMessage, readCommits } = require('./squash_attribution');
const { humanSquashMerge, verifiedHumanAuthor } = require('./human_squash_merge');
const { promisify } = require('node:util');

const run = promisify(execFile);
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
const executeGh = args => run(gh, args, { timeout: 120000 });

// The asynchronous endpoint is recommended for ordinary PRs as well as stacks.
// Keep one-off squash merges scoped to the selected PR and let GitHub enforce
// branch protections and merge-queue requirements.
async function squashMergePullRequest(url, execute = executeGh, confirmNonMain = async () => false,
  { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), pollAttempts = 12, pollIntervalMs = 1000,
    humanMerge = humanSquashMerge, readAPI } = {}) {
  const match = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/);
  if (!match) throw new Error('Could not identify the pull request. Refresh the GitHub Pull Requests view and use the merge button on its PR row.');
  const repo = `${match[1]}/${match[2]}`;
  const number = match[3];
  const fields = 'state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,title';
  const read = async () => JSON.parse((await execute(['pr', 'view', number, '--repo', repo, '--json', fields])).stdout);
  const pr = await read();
  if (pr.state !== 'OPEN' || pr.isDraft || !pr.baseRefName || !/^[0-9a-f]{40}$/i.test(pr.headRefOid)) {
    throw new Error('Only open, ready-for-review pull requests with a valid base branch can be squash-merged.');
  }
  const conflict = () => Object.assign(
    new Error(`Unable to merge #${number}: conflicts with \`${pr.baseRefName}\``),
    { code: 'SWEETIEBOT_MERGE_CONFLICT' }
  );
  if (pr.mergeable === 'CONFLICTING') throw conflict();
  if (pr.baseRefName !== 'main' &&
      !(await confirmNonMain({ repo, number, base: pr.baseRefName }))) {
    return { merged: false, cancelled: true, repo, number, base: pr.baseRefName };
  }
  // Validate the selected destination as well as the head just before invoking
  // GitHub, including for main-targeted PRs (where there is no confirmation).
  const latest = await read();
  if (latest.state !== 'OPEN' || latest.isDraft ||
      latest.baseRefName !== pr.baseRefName || latest.headRefName !== pr.headRefName ||
      latest.headRefOid !== pr.headRefOid || latest.title !== pr.title) {
    throw new Error(`PR #${number} changed since selection. Refresh and try again.`);
  }
  if (latest.mergeable === 'CONFLICTING') throw conflict();

  const endpoint = `repos/${repo}/pulls/${number}/merge-async`;
  const versionHeader = ['-H', 'X-GitHub-Api-Version: 2026-03-10'];
  const api = async args => {
    const endpoint = args.length === 1 ? args[0] : '';
    // Writes and async-merge requests always retain the user's GH_TOKEN.
    if (readAPI && endpoint.startsWith('repos/' + repo + '/') &&
        /\/(?:pulls\/[0-9]+(?:\/commits(?:\?.*)?)?|git\/commits\/[a-f0-9]{40})$/i.test(endpoint)) {
      return readAPI(endpoint);
    }
    return JSON.parse((await execute(['api', ...versionHeader, ...args])).stdout);
  };
  // An async merge of a native stacked PR also includes its open downstack
  // ancestors. The one-click action is only for one-offs; the bulk workflow
  // owns intentional stack merges and their attribution checks.
  const metadata = await api([`repos/${repo}/pulls/${number}`]);
  if (metadata?.stack) {
    throw new Error(`PR #${number} belongs to a GitHub-native stack. Use the bulk merge workflow to select the intended layers.`);
  }
  // GitHub's native squash endpoint assigns the PR opener as Git author.
  // For bot-opened PRs, locally squash on that same PR head with the original
  // verified human author, then use GitHub's native one-commit rebase merge.
  // Never submit a bot-authored native squash as a silent fallback.
  if (!metadata?.user?.login || !['Bot', 'User'].includes(metadata.user.type)) {
    throw new Error('Cannot verify PR opener identity; refusing a possibly bot-authored squash.');
  }
  if (metadata.user.type === 'Bot' || /\[bot\]$/i.test(metadata.user.login)) {
    const landed = await humanMerge(repo, Number(number), { allowHistoryRewrite: true });
    if (!landed.merged) throw new Error(landed.reason || 'The PR remains open; its guarded squash merge is not complete.');
    const finished = await read();
    if (!landed.merged || finished.state !== 'MERGED' ||
        finished.baseRefName !== pr.baseRefName || finished.headRefName !== pr.headRefName) {
      throw new Error('Human-authored squash landed but its GitHub PR state could not be verified.');
    }
    return { merged: true, repo, number, base: pr.baseRefName, pr: finished,
      sha: landed.sha, author: landed.author };
  }
  if (!pr.title || (metadata?.title && metadata.title !== pr.title)) {
    throw new Error(`PR #${number} title is unavailable or changed; merge blocked.`);
  }
  // Do not trust a human PR opener as proof of original human authorship:
  // GitHub's native squash credits the opener rather than the original author.
  const commits = await readCommits(api, repo, Number(number));
  const human = verifiedHumanAuthor(commits);
  if (human.login.toLowerCase() !== metadata.user.login.toLowerCase()) {
    const landed = await humanMerge(repo, Number(number), { allowHistoryRewrite: true });
    if (!landed.merged) throw new Error(landed.reason || 'The PR remains open; its guarded squash merge is not complete.');
    const finished = await read();
    if (!landed.merged || finished.state !== 'MERGED' ||
        finished.baseRefName !== pr.baseRefName || finished.headRefName !== pr.headRefName) {
      throw new Error('Original human Git author was not verified after the guarded merge.');
    }
    return { merged: true, repo, number, base: pr.baseRefName, pr: finished,
      sha: landed.sha, author: landed.author };
  }
  const squash = squashMessage(pr.title, Number(number), commits);
  let outcome;
  let resumed = false;
  try {
    outcome = await api(['--method', 'PUT', endpoint,
      '-f', `sha=${pr.headRefOid}`, '-f', 'merge_method=squash', '-f', 'merge_action=direct_merge',
      '-f', `commit_title=${squash.title}`, '-f', `commit_message=${squash.message}`]);
  } catch (error) {
    const detail = `${error.stderr || ''}
${error.message || ''}`;
    if (/\bHTTP 409\b/.test(detail)) {
      // GitHub returns the existing request in stdout, even though gh exits
      // nonzero. Matching options allow read-only status polling, not an
      // assumption that the earlier request preserves our commit metadata.
      try { outcome = JSON.parse(error.stdout); } catch {}
      const existing = outcome?.details;
      if (outcome?.status !== 'pending' ||
          !/^[0-9a-f-]{36}$/i.test(existing?.uuid || '') ||
          existing.expected_head_sha !== pr.headRefOid ||
          existing.merge_method !== 'squash' || existing.merge_action !== 'direct_merge' ||
          existing.bypass_rules !== false) {
        throw new Error(`PR #${number} has a different or unverifiable asynchronous merge request. Its merge options were preserved; inspect the request on GitHub.`);
      }
      resumed = true;
    } else {
      const updated = await read().catch(() => undefined);
      if (updated?.mergeable === 'CONFLICTING') throw conflict();
      throw error;
    }
  }

  const requestId = outcome?.details?.uuid;
  for (let attempt = 0; outcome?.status === 'pending' && attempt < pollAttempts; attempt++) {
    if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) {
      throw new Error(`GitHub returned an asynchronous merge without a valid request ID for PR #${number}.`);
    }
    await wait(pollIntervalMs);
    outcome = await api([`${endpoint}/${requestId}`]);
  }
  if (outcome?.status === 'failed') {
    throw new Error(`Unable to merge PR #${number}: ${outcome.details?.message || 'GitHub rejected the asynchronous merge.'}`);
  }
  if (outcome?.status === 'enqueued') throw new Error(`PR #${number} entered a merge queue without verified custom metadata.`);
  if (!['pending', 'merged'].includes(outcome?.status)) {
    throw new Error(`GitHub returned an unexpected asynchronous merge status for PR #${number}.`);
  }

  // A completed async request may still be followed by a short period of API
  // propagation. Never delete branches or close the PR tab until its actual
  // PR state confirms the merge, including for merge-queue requests.
  let confirmed = await read();
  if (confirmed.baseRefName !== pr.baseRefName ||
      confirmed.headRefName !== pr.headRefName || confirmed.headRefOid !== pr.headRefOid) {
    throw new Error('The pull request changed during merging; branch cleanup was skipped.');
  }
  // An old async request can remain pending while GitHub reports a clean PR.
  // The synchronous single-PR endpoint uses the same SHA and exact metadata;
  // it cannot include downstack PRs or bypass repository protections.
  if (resumed && outcome.status === 'pending' && confirmed.state === 'OPEN'
      && confirmed.mergeable === 'MERGEABLE') {
    if (confirmed.title !== pr.title) throw new Error('The PR title changed; merge recovery was skipped.');
    try {
      await api(['--method', 'PUT', `repos/${repo}/pulls/${number}/merge`,
        '-f', `sha=${pr.headRefOid}`, '-f', 'merge_method=squash',
        '-f', `commit_title=${squash.title}`, '-f', `commit_message=${squash.message}`]);
    } catch {
      // A racing async completion or a still-pending GitHub lock is resolved
      // by reading the PR; never infer success from an attempted recovery.
    }
    confirmed = await read();
    if (confirmed.baseRefName !== pr.baseRefName || confirmed.headRefName !== pr.headRefName
        || confirmed.headRefOid !== pr.headRefOid) {
      throw new Error('The PR changed during merge recovery; branch cleanup was skipped.');
    }
  }
  if (confirmed.state === 'MERGED') {
    if (resumed) {
      // A 409 does not include commit_title/commit_message. Verify the actual
      // commit before claiming success or allowing destructive branch cleanup.
      let merged = await api([`repos/${repo}/pulls/${number}`]);
      // PR state and the REST merge commit can briefly propagate separately.
      for (let attempt = 0; attempt < 4 && (!merged?.merged || !merged?.merge_commit_sha); attempt++) {
        await wait(500);
        merged = await api([`repos/${repo}/pulls/${number}`]);
      }
      const sha = merged?.merge_commit_sha;
      if (!merged?.merged || !/^[0-9a-f]{40}$/i.test(sha || '')) {
        throw new Error(`PR #${number} merged, but its squash commit could not be verified. Branch cleanup was skipped.`);
      }
      const commit = await api([`repos/${repo}/git/commits/${sha}`]);
      const expected = `${squash.title}\n\n${squash.message}`;
      if (commit?.message?.replace(/\r\n/g, '\n').trimEnd() !== expected.trimEnd()) {
        throw new Error(`PR #${number} merged, but its squash title or contributor attribution differs from the requested metadata. Branch cleanup was skipped.`);
      }
    }
    return { merged: true, repo, number, base: pr.baseRefName, pr: confirmed };
  }
  return { merged: false, repo, number, base: pr.baseRefName,
    pending: outcome.status === 'pending' || outcome.status === 'merged',
    enqueued: outcome.status === 'enqueued' };
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

async function resolveMergeTarget(vscode, node) {
  const direct = pullRequestFromTreeNode(node);
  if (direct.url) return direct;
  // Even if the GitHub extension's private resolver is not installed yet,
  // an actual clicked PRNode can render its own TreeItem with a PR resource URI.
  if (node && typeof node.getTreeItem === 'function') {
    try {
      const item = pullRequestFromTreeNode(await node.getTreeItem());
      if (item.url && (direct.number == null || item.number === Number(direct.number))) return item;
    } catch {
      // Fall through to the extension-owned resolver and one guarded refresh.
    }
  }


  const resolver = 'sweetiebot.resolveSelectedPullRequest';
  const resolve = async () => {
    try {
      if (!(await vscode.commands.getCommands(true)).includes(resolver)) return;
      // Always resolve the original clicked row. A selected PR from another
      // row must never be substituted just because the tree is still loading.
      const model = pullRequestFromTreeNode(await vscode.commands.executeCommand(resolver, node));
      if (!model.url) return;
      if (direct.number != null && Number(direct.number) !== model.number) return;
      return model;
    } catch {
      // A row may not have its rendered TreeItem yet.
      return;
    }
  };

  // Inline tree commands can fire before VS Code has published the selection
  // or completed the first TreeItem. Give the UI a turn before resolving it.
  await new Promise(resolve => setTimeout(resolve, 0));
  const immediate = await resolve();
  if (immediate) return immediate;

  // Refresh once and retry this *same* row automatically rather than making
  // the user click its merge button again. Failure remains non-destructive.
  await vscode.commands.executeCommand('pr.refreshList').catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  return (await resolve()) || direct;
}

// GitHub Pull Requests renders PR overviews as webview tabs titled
// "#<number> <title>" with a 20-character, word-boundary truncation.
// Match both the native webview type and its full displayed label: a PR
// number alone also occurs in other repositories (and in issue tabs).
function pullRequestOverviewLabel(number, title) {
  if (!/^[1-9]\d*$/.test(String(number)) || typeof title !== 'string' || !title.trim()) return;
  let abbreviated = title;
  if (title.length > 20) {
    const lastSpace = title.lastIndexOf(' ', 20);
    abbreviated = title.substring(0, lastSpace > 0 ? lastSpace : 20) + '...';
  }
  return `#${number} ${abbreviated}`;
}

async function closeMergedPullRequestTab(vscode, result) {
  if (!result?.merged) return false;
  const label = pullRequestOverviewLabel(result.number, result.pr?.title);
  const tabGroups = vscode.window?.tabGroups;
  if (!label || !tabGroups?.all || typeof tabGroups.close !== 'function' ||
      typeof vscode.TabInputWebview !== 'function') return false;
  const matches = tabGroups.all.flatMap(group => group.tabs || []).filter(tab =>
    tab.input instanceof vscode.TabInputWebview &&
    /(?:^|\.)PullRequestOverview$/.test(tab.input.viewType || '') &&
    tab.label === label);
  // The VS Code Tabs API exposes a webview's title/type but not its repository
  // identity. Never guess which tab to close if multiple tabs look identical.
  if (matches.length !== 1) return false;
  return tabGroups.close(matches[0], true);
}

function registerGitHubPullRequestActions(vscode, context, merge = squashMergePullRequest) {
  const busy = new Set();
  const processMerge = async (node, progress) => {
    // Resolve the exact clicked PR row for both command entry points. A row
    // without a URL may expose it only through its asynchronous TreeItem.
    const model = await resolveMergeTarget(vscode, node);
    const url = model.url;
    if (busy.has(url)) return;
    busy.add(url);
    try {
      // Never invoke a merge with an unresolved or mismatched PR identity.
      if (!url) throw new Error('Could not identify the pull request. Refresh the GitHub Pull Requests view and use the merge button on its PR row.');
      progress?.report?.({ message: 'Checking merge eligibility…' });
      const confirmNonMain = async ({ number, base }) => {
        const action = `Squash into ${base}`;
        const choice = await vscode.window.showWarningMessage(
          `PR #${number} targets \`${base}\`, not \`main\`. Confirm squash-merge into \`${base}\`?`,
          { modal: true, detail: 'This will merge into the displayed branch, not main.' },
          action
        );
        return choice === action;
      };
      const session = await require('./github_session').githubSession(vscode);
      const execute = async args => {
        try { return await run(gh, args, { timeout: 120000, env: { ...process.env, GH_TOKEN: session.accessToken, GH_PROMPT_DISABLED: '1' } }); }
        catch (error) { throw require('./github_rate_limit').rateLimitError({ status: 403, message: error.stderr || error.message }) || error; }
      };
      const userAPI = require('./github_user_api').githubUserAPI(session.accessToken);
      const repo = new URL(url).pathname.slice(1).split('/').slice(0, 2).join('/');
      const appRead = require('./github_user_api').githubUserAPI(session.accessToken,
        require('./github_read_api').createLindseyReadFetch(repo));
      const humanAPI = (endpoint, method = 'GET', fields = []) => {
        const body = {};
        for (let i = 0; i < fields.length; i += 2) {
          const split = fields[i + 1].indexOf('='); body[fields[i + 1].slice(0, split)] = fields[i + 1].slice(split + 1);
        }
        return (method === 'GET' && endpoint.startsWith('repos/' + repo + '/') ? appRead : userAPI)
          (endpoint, { method, ...(method === 'GET' ? {} : { body }) });
      };
      const result = await merge(url, execute, confirmNonMain, {
        readAPI: appRead,
        humanMerge: (repo, number, options) => humanSquashMerge(repo, number,
          { ...options, api: humanAPI, gitToken: session.accessToken })
      });
      if (result.cancelled) return { state: 'cancelled' };
      const base = result.base || result.pr?.baseRefName || 'main';
      if (!result.merged) {
        const status = result.pending ? 'asynchronous squash still processing'
          : result.enqueued ? 'added to merge queue' : 'queued for merge';
        vscode.window.showInformationMessage(`PR #${result.number} ${status}${base !== 'main' ? ` into \`${base}\`` : ''}.`);
        return { state: result.pending ? 'pending' : 'queued' };
      }
      vscode.window.showInformationMessage(`PR #${result.number} merged into ${base}.`);
      // Close only this merged PR's open overview, even when it is not the
      // active editor. Closing the tab must not affect successful merging.
      try {
        await closeMergedPullRequestTab(vscode, result);
      } catch (error) {
        vscode.window.showWarningMessage(`PR #${result.number} merged, but its tab could not be closed: ${error.message}`);
      }
      try {
        await deleteMergedRemoteBranch(result, execute);
      } catch (error) {
        vscode.window.showWarningMessage(`PR #${result.number} merged, but remote branch cleanup failed: ${error.stderr?.trim() || error.message}`);
      }
      try {
        const extension = vscode.extensions.getExtension('vscode.git');
        const api = extension && (await extension.activate()).getAPI(1);
        const repository = api?.repositories.find(candidate => candidate.state.remotes.some(remote =>
          [remote.fetchUrl, remote.pushUrl].some(value => value &&
            require('./pull_request').githubRepository(value) === `https://github.com/${result.repo}`)));
        // Default-branch cleanup must not infer that a non-main merge reached main.
        if (repository && base === 'main' && !result.pr.isCrossRepository && result.pr.headRefName !== 'main') {
          const installed = path.join(__dirname, 'prune_merged_branches.py');
          const script = existsSync(installed) ? installed : path.join(__dirname, '../scripts/prune_merged_branches.py');
          await run(process.platform === 'win32' ? 'python' : 'python3', [script, '--force', '--repo',
            repository.rootUri.fsPath, `--branch=${result.pr.headRefName}`], { timeout: 120000 });
          await repository.status();
        }
      } catch (error) {
        vscode.window.showWarningMessage(`PR #${result.number} merged, but local branch cleanup failed: ${error.message}`);
      }
      return { state: 'merged' };
    } catch (error) {
      const detail = error.code === 'SWEETIEBOT_MERGE_CONFLICT'
        ? error.message
        : error.stderr?.trim() || error.message;
      if (!await require('./github_rate_limit').promptRateLimit(vscode, error)) vscode.window.showErrorMessage(detail);
      return { state: 'failed' };
    } finally {
      busy.delete(url);
      await vscode.commands.executeCommand('pr.refreshList').catch(() => {});
    }
  };
  const handler = (node, options) => {
    // The PR sidebar's tree command starts its own notification at the exact
    // click point. Do not show a second one when it forwards the selected URL.
    if (options?.progressManaged === true) return processMerge(node);
    // Open progress on the click, including while the GitHub PR extension is
    // still resolving the exact row. This is a single ongoing notification,
    // not an early claim that the merge succeeded.
    const clicked = pullRequestFromTreeNode(node);
    if (clicked.url && busy.has(clicked.url)) return;
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: clicked.number ? `Squash merge PR #${clicked.number}` : 'Squash merge',
      cancellable: false
    }, progress => processMerge(node, progress));
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.squashMergePullRequest', handler),
    vscode.commands.registerCommand('sweetiebot.squashMergeSelectedPullRequest', handler)
  );
}

module.exports = { squashMergePullRequest, deleteMergedRemoteBranch, resolveMergeTarget, closeMergedPullRequestTab, registerGitHubPullRequestActions };
