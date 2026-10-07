function pullRequestFromTreeNode(node) {
  const model = node?.pullRequestModel ?? node;
  const direct = model?.html_url ?? model?.htmlUrl ?? model?.url;
  const directMatch = String(direct || '').match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/
  );
  if (directMatch) {
    return { url: directMatch[0].replace(/\/$/, ''), number: Number(model?.number ?? directMatch[3]) };
  }

  const resourceUri = node?.resourceUri ?? model?.resourceUri;
  let identifier;
  try {
    identifier = JSON.parse(String(resourceUri?.query || '')).prIdentifier;
  } catch {
    identifier = undefined;
  }
  const uriMatch = String(identifier || '').match(
    /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+):([1-9]\d*)$/
  );
  return uriMatch
    ? { url: `${uriMatch[1]}/pull/${uriMatch[2]}`, number: Number(uriMatch[2]) }
    : { url: undefined, number: model?.number };
}

function installPullRequestRefresh(vscode, view, owner) {
  // Resolve tree nodes in the extension host that owns the GitHub PR tree.
  owner._register(vscode.commands.registerCommand('scmToolkit.squashMergeSelectedPullRequest', node => {
    return vscode.commands.executeCommand(
      'scmToolkit.squashMergePullRequest',
      pullRequestFromTreeNode(node)
    );
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

module.exports = { installPullRequestRefresh };
