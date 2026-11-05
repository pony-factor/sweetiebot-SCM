'use strict';

const { coauthorTrailer, readCommitGitSetting } = require('./codex-commit');

const AUTO_COMMIT_INTERVAL_MS = 30_000;
const AUTO_COMMIT_KEY_PREFIX = 'sweetiebot.autoCommitForBranch.v1:';

// VS Code workspaceState belongs to this workspace/window's extension host.
// A repository + exact branch is opted in only after the clock is clicked.
function preferenceKey(root, branch) {
  if (root?.scheme !== 'file' || !root.fsPath || typeof branch !== 'string' || !branch) return;
  return AUTO_COMMIT_KEY_PREFIX + JSON.stringify([root.fsPath, branch]);
}

function isAutoCommitEnabled(store, root, branch) {
  const key = preferenceKey(root, branch);
  return Boolean(key && store?.get(key, false) === true);
}

function hasPendingChanges(state) {
  return Boolean(
    state?.indexChanges?.length
    || state?.workingTreeChanges?.length
    || state?.untrackedChanges?.length
  );
}

// The timer is per extension host. Only repositories whose checked-out branch
// has been explicitly enabled in this workspace may enter the commit queue.
async function scanAutoCodexCommits(vscode, store, busy = new Set(), reported = new Map()) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const git = await extension.activate();
  const repositories = git.getAPI(1).repositories || [];
  await Promise.all(repositories.map(async repository => {
    const root = repository.rootUri;
    if (root?.scheme !== 'file' || !root.fsPath) return;
    if (busy.has(root.fsPath)) return;
    busy.add(root.fsPath);
    try {
      if (vscode.workspace.getConfiguration('git', root).get('enabled', true) === false) return;
      await repository.status();
      const state = repository.state;
      const branch = state?.HEAD?.name;
      if (!isAutoCommitEnabled(store, root, branch)) {
        reported.delete(root.fsPath);
        return;
      }
      if (state.mergeChanges?.length || repository.inputBox?.value?.trim() || !hasPendingChanges(state)) {
        reported.delete(root.fsPath);
        return;
      }
      const [name, email] = await Promise.all([
        readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-coauthor-name', 'Codex'),
        readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-coauthor-email', 'noreply@openai.com')
      ]);
      // The user can switch branches or turn the clock off during an await.
      await repository.status();
      if (repository.state?.HEAD?.name !== branch
          || !isAutoCommitEnabled(store, root, branch)
          || repository.state.mergeChanges?.length
          || repository.inputBox?.value?.trim()
          || !hasPendingChanges(repository.state)) return;
      const result = await vscode.commands.executeCommand('sweetiebot.queueCommit', root, {
        all: true,
        codex: false,
        trailer: coauthorTrailer(name, email),
        push: false,
        expectedBranch: branch
      });
      if (result?.queued) reported.delete(root.fsPath);
    } catch (error) {
      const message = error?.message || String(error);
      if (reported.get(root.fsPath) !== message) {
        reported.set(root.fsPath, message);
        void vscode.window.showWarningMessage(
          'Sweetiebot automatic Codex commit paused for '
          + root.fsPath.split(/[\\/]/).pop() + ': ' + message
        );
      }
    } finally {
      busy.delete(root.fsPath);
    }
  }));
}

function registerAutoCodexCommit(vscode, context) {
  const store = context.workspaceState;
  context.subscriptions.push(vscode.commands.registerCommand(
    'sweetiebot.autoCommitForBranch', async (action, uri, branch) => {
      const root = uri && vscode.Uri.from(uri);
      const key = preferenceKey(root, branch);
      if (!key) return false;
      if (action === 'get') return isAutoCommitEnabled(store, root, branch);
      if (action !== 'toggle') throw new Error('Unknown automatic commit action.');
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) throw new Error('The Git extension is unavailable.');
      const git = await extension.activate();
      const repository = git.getAPI(1).getRepository(root);
      if (!repository) throw new Error('The selected repository is unavailable.');
      await repository.status();
      if (repository.state?.HEAD?.name !== branch) {
        throw new Error('The checked-out branch changed. Select the branch and retry.');
      }
      const enabled = !isAutoCommitEnabled(store, root, branch);
      await store.update(key, enabled);
      return enabled;
    }
  ));
  const busy = new Set();
  const reported = new Map();
  let scanning = false;
  let disposed = false;
  const scan = async () => {
    if (scanning || disposed) return;
    scanning = true;
    try {
      await scanAutoCodexCommits(vscode, store, busy, reported);
    } catch (error) {
      console.warn('Sweetiebot automatic Codex commit scan:', error);
    } finally {
      scanning = false;
    }
  };
  // No startup commit: first check happens after a full 30-second interval.
  const timer = setInterval(() => { void scan(); }, AUTO_COMMIT_INTERVAL_MS);
  context.subscriptions.push({ dispose() {
    disposed = true;
    clearInterval(timer);
  } });
}

module.exports = {
  AUTO_COMMIT_INTERVAL_MS, preferenceKey, isAutoCommitEnabled, hasPendingChanges,
  scanAutoCodexCommits, registerAutoCodexCommit
};
