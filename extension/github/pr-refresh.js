const { readMergeChecks } = require("../merge/checks");
const { githubSession } = require("./session");

// A folder action is only a shortcut for independently safe one-PR merges.
// Live GitHub state, not the sidebar glyph or cached tree model, determines
// which PRs are offered. Any unavailable evidence excludes that PR.
async function checkFolderMergeEligibility(request, accessToken, fetchImpl = globalThis.fetch) {
  const match = String(request?.url || "").match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/
  );
  if (!match || Number(match[3]) !== request.number || !accessToken) {
    return { eligible: false, reason: "Cannot verify the selected PR identity or GitHub session" };
  }
  const repository = match[1] + "/" + match[2];
  const prefix = "repos/" + repository + "/";
  const api = async endpoint => {
    if (!endpoint.startsWith(prefix)) throw Error("Unexpected GitHub eligibility endpoint");
    const response = await fetchImpl("https://api.github.com/" + endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + accessToken,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) throw Error("GitHub returned HTTP " + response.status);
    return response.json();
  };
  try {
    const pr = await api(prefix + "pulls/" + request.number);
    if (pr?.state !== "open" || pr.draft) {
      return { eligible: false, reason: "PR is closed or in draft" };
    }
    if (String(pr.html_url || "").toLowerCase() !== request.url.toLowerCase() ||
        !/^[a-f0-9]{40}$/i.test(pr.head?.sha || "") || !pr.base?.ref ||
        !pr.title || !pr.head?.ref) {
      return { eligible: false, reason: "GitHub did not confirm the PR head, base and title" };
    }
    const snapshot = {
      headSha: pr.head.sha, head: pr.head.ref, base: pr.base.ref, title: pr.title
    };
    if (pr.stack) return { ...snapshot, eligible: false, reason: "Use the stack-aware bulk merge workflow" };
    if (pr.mergeable === false || pr.mergeable_state === "dirty") {
      return { ...snapshot, eligible: false, reason: "Merge conflicts" };
    }
    if (pr.mergeable_state === "blocked") {
      return { ...snapshot, eligible: false, reason: "Reviews or GitHub merge rules are blocking" };
    }
    if (pr.mergeable_state === "behind") {
      return { ...snapshot, eligible: false, reason: "Branch needs an update before merging" };
    }
    // "unstable" alone does not tell us whether checks failed or are pending.
    // Reuse the actual CI reader for cancelled, failed and in-progress checks.
    const checks = await readMergeChecks(api, repository, pr.head.sha);
    if (checks.state === "failed") {
      return { ...snapshot, eligible: false,
        reason: "Checks not passing: " + checks.names.slice(0, 3).join(", ") +
          (checks.names.length > 3 ? "…" : "") };
    }
    if (checks.state === "pending") {
      return { ...snapshot, eligible: false, reason: "Checks pending" };
    }
    if (pr.mergeable !== true || pr.mergeable_state !== "clean") {
      return { ...snapshot, eligible: false,
        reason: "GitHub has not confirmed merge readiness (" + (pr.mergeable_state || "unknown") + ")" };
    }
    return { ...snapshot, eligible: true };
  } catch (error) {
    // An API, permission or rate-limit failure must not become permission
    // to merge, including if the sidebar still displays a green checkmark.
    return { eligible: false, reason: "Unable to verify eligibility: " + (error?.message || String(error)) };
  }
}

function pullRequestFromTreeNode(node) {
  if (Array.isArray(node)) node = node.length === 1 ? node[0] : undefined;
  if (!node) return { url: undefined, number: undefined };

  // VS Code passes either a PRNode, its rendered TreeItem, or occasionally a
  // plain command argument. The TreeItem's command points back to the PRNode.
  const argumentsNode = node.command?.arguments?.length === 1 ? node.command.arguments[0] : undefined;
  const candidates = [node, node.pullRequestModel, argumentsNode, argumentsNode?.pullRequestModel]
    .filter(Boolean);
  const parseUrl = value => {
    const matched = String(value || '').match(
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/i
    );
    return matched ? { url: `https://github.com/${matched[1]}/${matched[2]}/pull/${matched[3]}`,
      number: Number(matched[3]) } : undefined;
  };
  const numberHint = candidates.map(candidate => candidate?.number)
    .find(value => /^[1-9]\d*$/.test(String(value)));

  for (const candidate of candidates) {
    for (const url of [typeof candidate === 'string' ? candidate : undefined,
      candidate?.html_url, candidate?.htmlUrl, candidate?.url]) {
      const result = parseUrl(url);
      if (result) return result;
    }
  }

  // GitHub's PR tree often exposes the identity on a rendered TreeItem URI.
  for (const candidate of candidates) {
    const resourceUri = candidate?.resourceUri ?? (candidate?.scheme === 'prnode' ? candidate : undefined);
    let identifier;
    try { identifier = JSON.parse(String(resourceUri?.query || '')).prIdentifier; }
    catch { identifier = undefined; }
    const match = String(identifier || '').match(/^(.*):([1-9]\d*)$/);
    const remote = match?.[1];
    const repo = String(remote || '').match(
      /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
    );
    if (repo) return { url: `https://github.com/${repo[1]}/${repo[2]}/pull/${match[2]}`,
      number: Number(match[2]) };
  }

  // A PRNode also includes a remote plus the PR number. Never infer a
  // repository from the currently active VS Code workspace or selected row.
  for (const candidate of candidates) {
    const remote = candidate?.remote?.url ?? candidate?.remote ??
      candidate?.githubRepository?.remote?.url;
    const repo = String(remote || '').match(
      /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
    );
    const number = candidate?.number ?? numberHint;
    if (repo && /^[1-9]\d*$/.test(String(number))) {
      return { url: `https://github.com/${repo[1]}/${repo[2]}/pull/${number}`, number: Number(number) };
    }
  }

  // When only the rendered TreeItem survives, GitHub supplies its canonical
  // PR URL as a substring of the item's stable ID (after the category ID).
  const id = typeof node.id === 'string' ? node.id : '';
  const urls = [...id.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)/gi)];
  if (urls.length === 1 && (!numberHint || Number(urls[0][1]) === Number(numberHint))) {
    return parseUrl(urls[0][0]);
  }
  return { url: undefined, number: numberHint };
}

// Prefer the PR model's title, then the displayed tree row label. The list
// always includes a canonical number/URL even if GitHub has not loaded a title.
function pullRequestTitle(node) {
  for (const value of [node?.pullRequestModel?.title, node?.title, node?.label]) {
    const text = typeof value === 'string' ? value : value?.label;
    if (typeof text === 'string' && text.trim()) return text.trim().replace(/\s+/g, ' ');
  }
  return undefined;
}

// Folder rows in GitHub's PR tree share the same merge context as PR rows.
// Snapshot the descendants in displayed order before merging; never treat a
// category/folder as a pull request or substitute the currently selected row.
async function pullRequestsInFolder(owner, folder) {
  if (!folder || typeof owner.getChildren !== 'function') return [];
  const seenNodes = new Set();
  const seenUrls = new Set();
  const requests = [];
  const visit = async node => {
    if (!node || seenNodes.has(node)) return;
    seenNodes.add(node);
    let model = pullRequestFromTreeNode(node);
    let title = pullRequestTitle(node);
    if ((!model.url || !title) && typeof owner.getTreeItem === 'function') {
      try {
        const item = await owner.getTreeItem(node);
        const rendered = pullRequestFromTreeNode(item);
        if (!model.url && rendered.url && (model.number == null || model.number === rendered.number)) {
          model = rendered;
        }
        if (!title && model.url) title = pullRequestTitle(item);
      } catch {
        // A non-PR folder or stale PR may not provide a rendered item.
      }
    }
    if (model.url) {
      if (!seenUrls.has(model.url)) {
        seenUrls.add(model.url);
        requests.push({ node, url: model.url, number: model.number, title });
      }
      return;
    }
    const children = await owner.getChildren(node);
    if (Array.isArray(children)) {
      for (const child of children) await visit(child);
    }
  };
  const children = await owner.getChildren(folder);
  if (Array.isArray(children)) {
    for (const child of children) await visit(child);
  }
  return requests;
}

function installPullRequestRefresh(vscode, view, owner, { checkBulkEligibility = checkFolderMergeEligibility } = {}) {
  // Sweetiebot owns the public merge commands and their legacy aliases.
  // Only resolve nodes here, in the extension that owns the GitHub PR tree.
  const resolve = async node => {
    const selected = node ?? (view.selection?.length === 1 ? view.selection[0] : undefined);
    let model = pullRequestFromTreeNode(selected);
    // Some GitHub nodes expose the PR URI only on their rendered TreeItem.
    // Resolve that exact node, never substitute another selected PR.
    if (!model.url && selected && typeof owner.getTreeItem === 'function') {
      try {
        const rendered = pullRequestFromTreeNode(await owner.getTreeItem(selected));
        if (model.number == null || rendered.number === Number(model.number)) model = rendered;
      }
      catch {
        // Leave unresolved nodes to the existing actionable error.
      }
    }
    return model;
  };
  owner._register(vscode.commands.registerCommand('sweetiebot.resolveSelectedPullRequest', resolve));
  // The inline PR action runs alongside GitHub's tree provider. Redraw the
  // clicked row locally instead of forcing an expensive remote list refresh.
  const rowStates = new Map();
  const rowTimers = new Map();
  const mergingUrls = new Set();
  const stateLabels = {
    merging: '⏳ Squash-merging…',
    pending: '⏳ GitHub is processing the merge',
    queued: '⏳ Merge queued',
    merged: '✅ Merged'
  };
  const originalGetTreeItem = owner.getTreeItem;
  const originalDescriptor = Object.getOwnPropertyDescriptor(owner, 'getTreeItem');
  const decorateTreeItem = typeof originalGetTreeItem === 'function' ? async function (node) {
    const item = await originalGetTreeItem.call(this, node);
    const state = rowStates.get(pullRequestFromTreeNode(node).url);
    if (!state || !item) return item;
    const existing = typeof item.description === 'string' ? item.description : '';
    item.description = existing + (existing ? ' · ' : '') + stateLabels[state];
    // Hide the inline merge button during an in-flight/confirmed operation.
    if (typeof item.contextValue === 'string') item.contextValue += ':sweetiebotMergeBusy';
    return item;
  } : undefined;
  if (decorateTreeItem) {
    owner.getTreeItem = decorateTreeItem;
    owner._register({ dispose() {
      if (owner.getTreeItem === decorateTreeItem) {
        if (originalDescriptor) Object.defineProperty(owner, 'getTreeItem', originalDescriptor);
        else delete owner.getTreeItem;
      }
      for (const timer of rowTimers.values()) clearTimeout(timer);
      rowTimers.clear();
      rowStates.clear();
      mergingUrls.clear();
    } });
  }
  const markMergeRow = (url, node, state) => {
    if (rowTimers.has(url)) clearTimeout(rowTimers.get(url));
    rowTimers.delete(url);
    if (state && decorateTreeItem) rowStates.set(url, state);
    else rowStates.delete(url);
    if (node && typeof owner.refresh === 'function') {
      try { owner.refresh(node); } catch { // Visual feedback must never block a merge.
      }
    }
    // Completed/queued badges persist briefly in case GitHub has not yet
    // removed the PR from the open list; never keep a stale badge forever.
    if (state === 'merged' || state === 'queued' || state === 'pending') {
      const timer = setTimeout(() => {
        rowTimers.delete(url);
        if (rowStates.get(url) === state) {
          rowStates.delete(url);
          if (node && typeof owner.refresh === 'function') {
            try { owner.refresh(node); } catch {}
          }
        }
      }, 15000);
      timer.unref?.();
      rowTimers.set(url, timer);
    }
  };

  // Tree command arguments belong to the extension host that owns the view.
  // Resolve them here before handing a serializable URL to Sweetiebot.
  const mergeTreeRow = async (node, progress) => {
    let model = node ? await resolve(node) : {};
    if (node && !model.url) {
      // A stale row can resolve before GitHub finishes hydrating its model.
      // Refresh once, then retry the original click rather than the selection.
      try { await vscode.commands.executeCommand('pr.refreshList'); } catch {}
      await new Promise(done => setTimeout(done, 250));
      model = await resolve(node);
    }
    if (!model.url) {
      return vscode.window.showErrorMessage('Could not identify the clicked pull request. Refresh the GitHub Pull Requests view and try again.');
    }
    if (mergingUrls.has(model.url)) return;
    mergingUrls.add(model.url);
    progress?.report?.({ message: 'Checking merge eligibility…' });
    markMergeRow(model.url, node, 'merging');
    try {
      // The inline action owns the progress notification; avoid a duplicate
      // notification from the shared single-PR command.
      const result = await vscode.commands.executeCommand('sweetiebot.squashMergePullRequest', model.url,
        { progressManaged: true });
      // A queued merge is not yet merged; cancellations and failures clear the row.
      const state = ['merged', 'queued', 'pending'].includes(result?.state) ? result.state : undefined;
      markMergeRow(model.url, node, state);
      return result;
    } catch (error) {
      markMergeRow(model.url, node);
      throw error;
    } finally {
      mergingUrls.delete(model.url);
    }
  };
  // The GitHub PR view also displays the inline action on folder/category
  // rows. Run its PR children one at a time through the same guarded action,
  // preserving each PR's own eligibility checks, attribution, and base.
  const mergingFolders = new Set();
  const mergeFolder = async folder => {
    let requests;
    try {
      requests = await pullRequestsInFolder(owner, folder);
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to read pull requests in this folder: ${error.message}`);
      return { state: 'failed', total: 0 };
    }
    if (!requests.length) {
      vscode.window.showErrorMessage('No pull requests were found in the selected folder.');
      return { state: 'failed', total: 0 };
    }
    let accessToken;
    try {
      accessToken = (await githubSession(vscode))?.accessToken;
      if (!accessToken) throw Error("A GitHub session is required");
    } catch (error) {
      vscode.window.showErrorMessage("Cannot verify bulk-merge eligibility: " + error.message);
      return { state: "failed", total: requests.length };
    }
    // Bound concurrent preflights to avoid a burst of GitHub API calls. Keep
    // the tree's displayed order without trusting its cached status badges.
    const checked = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Checking folder PR merge eligibility",
      cancellable: false
    }, async progress => {
      const results = [];
      for (let index = 0; index < requests.length; index += 3) {
        const group = await Promise.all(requests.slice(index, index + 3).map(async request => ({
          request, status: await checkBulkEligibility(request, accessToken)
        })));
        results.push(...group);
        progress?.report?.({ message: `Checked ${results.length}/${requests.length} PRs` });
      }
      return results;
    });
    const eligible = checked.filter(entry => entry.status.eligible);
    const excluded = checked.filter(entry => !entry.status.eligible);
    const count = eligible.length;
    const action = `Merge ${count} PR${count === 1 ? "" : "s"}`;
    const detail = [
      ...eligible.map(({ request }) => `#${request.number} — ${request.title || request.url}`),
      ...(excluded.length ? [
        "", `Excluded ${excluded.length} of ${requests.length} PRs:`,
        ...excluded.map(({ request, status }) => `#${request.number} — ${status.reason}`)
      ] : [])
    ].join("\n");
    if (!count) {
      await vscode.window.showWarningMessage(
        "No pull requests are currently eligible for bulk merge.",
        { modal: true, detail }
      );
      return { state: "blocked", total: requests.length, excluded: excluded.length };
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Squash merge ${count} eligible pull request${count === 1 ? "" : "s"}?`,
      { modal: true, detail }, action
    );
    if (confirmed !== action) return { state: "cancelled", total: requests.length };

    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Squash merge eligible folder pull requests",
      cancellable: false
    }, async progress => {
      const counts = { merged: 0, queued: 0, pending: 0, cancelled: 0, failed: 0, skipped: 0 };
      const skippedReasons = [];
      for (const [index, { request, status }] of eligible.entries()) {
        progress?.report?.({ message: `PR ${index + 1}/${count}: #${request.number}` });
        try {
          // Every earlier merge may change this PR's base or invalidate its
          // checks. Never rely on the confirmation-time eligibility snapshot.
          const fresh = await checkBulkEligibility(request, accessToken);
          const changed = fresh.eligible && (fresh.headSha !== status.headSha ||
            fresh.head !== status.head || fresh.base !== status.base || fresh.title !== status.title);
          if (!fresh.eligible || changed) {
            counts.skipped++;
            skippedReasons.push(`#${request.number}: ${changed ? "PR changed since confirmation" : fresh.reason}`);
            continue;
          }
          const result = await mergeTreeRow(request.node);
          const state = result?.state;
          if (Object.hasOwn(counts, state)) counts[state]++;
          else counts.failed++;
        } catch (error) {
          counts.failed++;
          vscode.window.showErrorMessage(`Unable to merge PR #${request.number}: ${error.message}`);
        }
      }
      const summary = `Folder merge: ${counts.merged} merged, ${counts.queued} queued, ${counts.pending} pending, ${counts.cancelled} cancelled, ${counts.failed} failed, ${counts.skipped} skipped (${excluded.length} excluded before confirmation).`;
      if (counts.failed || counts.cancelled || counts.skipped) {
        vscode.window.showWarningMessage(summary + (skippedReasons.length ? "\n" + skippedReasons.join("\n") : ""));
      } else vscode.window.showInformationMessage(summary);
      return { state: "completed", total: requests.length, excluded: excluded.length, ...counts };
    });
  };
  owner._register(vscode.commands.registerCommand('sweetiebot.squashMergeTreePullRequest', node => {
    const clicked = pullRequestFromTreeNode(node);
    if (clicked.url && mergingUrls.has(clicked.url)) return;
    // Folders have no PR URL, but can contain several PR nodes. Do not route a
    // numbered yet-unresolved PR into the folder workflow.
    if (node && !clicked.url && clicked.number == null && typeof owner.getChildren === 'function') {
      if (mergingFolders.has(node)) return;
      mergingFolders.add(node);
      return mergeFolder(node).finally(() => mergingFolders.delete(node));
    }
    // Show feedback synchronously, even when the extension needs to hydrate a
    // stale row before it can safely identify the requested pull request.
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: clicked.number ? `Squash merge PR #${clicked.number}` : 'Squash merge',
      cancellable: false
    }, progress => mergeTreeRow(node, progress));
  }));
  let timer;
  let running = false;
  let disposed = false;
  let lastAttemptAt = -Infinity;
  let blockedUntil = 0;
  let consecutiveLimits = 0;
  const config = () => vscode.workspace.getConfiguration('sweetiebot');
  const interval = () => {
    const seconds = Number(config().get('pullRequestRefreshIntervalSeconds', 120));
    return Number.isFinite(seconds) ? Math.max(30, Math.min(3600, seconds)) * 1000 : 120000;
  };
  const active = () => !disposed && view.visible && vscode.window.state.focused &&
    config().get('pullRequestAutoRefresh', true);
  // GitHub Pull Requests can swallow fetch errors. Its patched formatter
  // reports them here without replacing native GitHub error notifications.
  const previousErrorHandler = globalThis.__sweetiebotGitHubPrRefreshError;
  const reportFetchError = message => {
    if (typeof previousErrorHandler === 'function') {
      try { previousErrorHandler(message); } catch {}
    }
    if (!/API rate limit exceeded|secondary rate limit|abuse detection|too many requests|HTTP 429/i.test(String(message))) return;
    const now = Date.now();
    if (now < blockedUntil) return; // Deduplicate multiple repository failures.
    consecutiveLimits = Math.min(consecutiveLimits + 1, 3);
    const fallback = Math.max(60, Math.min(3600, Number(config().get('githubRateLimitCooldownSeconds', 900)) || 900));
    blockedUntil = now + Math.min(3600000, fallback * 1000 * 2 ** (consecutiveLimits - 1));
    void Promise.resolve(vscode.commands.executeCommand('sweetiebot.githubRateLimited', String(message))).catch(() => {});
  };
  globalThis.__sweetiebotGitHubPrRefreshError = reportFetchError;
  const refresh = async () => {
    const now = Date.now();
    if (!active() || running || now < blockedUntil || now - lastAttemptAt < interval()) return;
    running = true;
    lastAttemptAt = now;
    const priorBlock = blockedUntil;
    try {
      await vscode.commands.executeCommand('pr.refreshList');
      if (blockedUntil === priorBlock) consecutiveLimits = 0;
    } catch (error) {
      reportFetchError(error?.message || String(error));
    } finally {
      running = false;
    }
  };
  const update = () => {
    clearInterval(timer);
    timer = undefined;
    if (active()) {
      void refresh();
      timer = setInterval(refresh, interval());
    }
  };
  let previouslyVisible = Boolean(view.visible);
  owner._register(view.onDidChangeVisibility(() => {
    const visible = Boolean(view.visible);
    // Opening the PR sidebar bypasses only the periodic interval, never
    // the in-flight request guard or the GitHub rate-limit cooldown.
    if (visible && !previouslyVisible) lastAttemptAt = -Infinity;
    previouslyVisible = visible;
    update();
  }));
  owner._register(vscode.window.onDidChangeWindowState(update));
  owner._register(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('sweetiebot.pullRequestAutoRefresh') ||
        event.affectsConfiguration('sweetiebot.pullRequestRefreshIntervalSeconds')) update();
  }));
  owner._register({ dispose() {
    disposed = true;
    clearInterval(timer);
    if (globalThis.__sweetiebotGitHubPrRefreshError === reportFetchError) {
      if (previousErrorHandler === undefined) delete globalThis.__sweetiebotGitHubPrRefreshError;
      else globalThis.__sweetiebotGitHubPrRefreshError = previousErrorHandler;
    }
  } });
  queueMicrotask(update);
  return view;
}

module.exports = { installPullRequestRefresh, pullRequestFromTreeNode, pullRequestsInFolder, checkFolderMergeEligibility };
