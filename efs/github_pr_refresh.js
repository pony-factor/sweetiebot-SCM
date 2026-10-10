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

function installPullRequestRefresh(vscode, view, owner) {
  // Sweetiebot owns the public merge commands and their legacy aliases.
  // Only resolve nodes here, in the extension that owns the GitHub PR tree.
  owner._register(vscode.commands.registerCommand('sweetiebot.resolveSelectedPullRequest', async node => {
    const selected = node ?? (view.selection?.length === 1 ? view.selection[0] : undefined);
    let model = pullRequestFromTreeNode(selected);
    // Some GitHub nodes expose the PR URI only on their rendered TreeItem.
    // Resolve that exact node, never substitute another selected PR.
    if (!model.url && selected && typeof owner.getTreeItem === 'function') {
      try { model = pullRequestFromTreeNode(await owner.getTreeItem(selected)); }
      catch {
        // Leave unresolved nodes to the existing actionable error.
      }
    }
    return model;
  }));
  let timer;
  let running = false;
  let disposed = false;
  const active = () => !disposed && view.visible && vscode.window.state.focused &&
    vscode.workspace.getConfiguration('scmToolkit').get('pullRequestAutoRefresh', true);
  const refresh = async () => {
    if (!active() || running) return;
    running = true;
    try {
      await vscode.commands.executeCommand('pr.refreshList');
    } catch {
      // A transient offline/authentication failure must not create recurring popups.
    } finally {
      running = false;
    }
  };
  const update = () => {
    clearInterval(timer);
    timer = undefined;
    if (active()) {
      void refresh();
      timer = setInterval(refresh, 5000);
    }
  };
  owner._register(view.onDidChangeVisibility(update));
  owner._register(vscode.window.onDidChangeWindowState(update));
  owner._register(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scmToolkit.pullRequestAutoRefresh')) update();
  }));
  owner._register({ dispose() { disposed = true; clearInterval(timer); } });
  queueMicrotask(update);
  return view;
}

module.exports = { installPullRequestRefresh, pullRequestFromTreeNode };
