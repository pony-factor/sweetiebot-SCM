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
  owner._register(vscode.commands.registerCommand('scmToolkit.squashMergeSelectedPullRequest', (...args) =>
    vscode.commands.executeCommand('sweetiebot.squashMergeSelectedPullRequest', ...args)));
  // Resolve tree nodes in the extension host that owns the GitHub PR tree.
  owner._register(vscode.commands.registerCommand('sweetiebot.squashMergeSelectedPullRequest', node => {
    return vscode.commands.executeCommand(
      'sweetiebot.squashMergePullRequest',
      pullRequestFromTreeNode(node ?? (view.selection?.length === 1 ? view.selection[0] : undefined))
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

module.exports = { installPullRequestRefresh, pullRequestFromTreeNode };
