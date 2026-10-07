function pullRequestFromTreeNode(node) {
  const model = node?.pullRequestModel ?? node;
  const directMatch = [model?.html_url, model?.htmlUrl, model?.url].map(value => String(value || '').match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/
  )).find(Boolean);
  if (directMatch) {
    return { url: directMatch[0].replace(/\/$/, ''), number: Number(directMatch[3]) };
  }

  const resourceUri = node?.resourceUri ?? model?.resourceUri;
  let identifier;
  try {
    identifier = JSON.parse(String(resourceUri?.query || '')).prIdentifier;
  } catch {
    identifier = undefined;
  }
  // PRNode identifiers contain the Git remote URL, which can be SSH or end in .git.
  const uriMatch = String(identifier || '').match(/^(.*):([1-9]\d*)$/);
  const remote = uriMatch?.[1] ?? model?.remote?.url;
  const repoMatch = String(remote || '').match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
  );
  const number = uriMatch?.[2] ?? model?.number;
  return repoMatch && /^[1-9]\d*$/.test(String(number))
    ? { url: `https://github.com/${repoMatch[1]}/${repoMatch[2]}/pull/${number}`, number: Number(number) }
    : { url: undefined, number: model?.number };
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
