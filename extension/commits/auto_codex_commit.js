'use strict';

const { coauthorTrailer, readCommitGitSetting } = require('./codex_commit');

const AUTO_COMMIT_INTERVAL_MS = 30_000;

function hasPendingChanges(state) {
  return Boolean(
    state?.indexChanges?.length
    || state?.workingTreeChanges?.length
    || state?.untrackedChanges?.length
  );
}

// Auto commits deliberately use the durable queue even when manual durable
// commits are disabled. This prevents long Ollama requests from blocking the
// window and preserves the existing commit and co-author safety checks.
async function scanAutoCodexCommits(vscode, busy = new Set(), reported = new Map()) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const git = await extension.activate();
  const repositories = git.getAPI(1).repositories || [];
  await Promise.all(repositories.map(async repository => {
    const root = repository.rootUri;
    if (root?.scheme !== 'file' || !root.fsPath) return;
    const setting = vscode.workspace.getConfiguration('scmToolkit', root);
    if (setting.get('autoCommitWithCodex', false) !== true) {
      reported.delete(root.fsPath);
      return;
    }
    if (busy.has(root.fsPath)) return;
    busy.add(root.fsPath);
    try {
      if (vscode.workspace.getConfiguration('git', root).get('enabled', true) === false) return;
      await repository.status();
      const state = repository.state;
      // Do not race a human-drafted commit or an in-progress conflict.
      if (!state || state.mergeChanges?.length || !state.HEAD?.name
          || repository.inputBox?.value?.trim() || !hasPendingChanges(state)) {
        reported.delete(root.fsPath);
        return;
      }
      const [name, email] = await Promise.all([
        readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-coauthor-name', 'Codex'),
        readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-coauthor-email', 'noreply@openai.com')
      ]);
      const trailer = coauthorTrailer(name, email);
      // Always stage the full set of saved changes. The queue checks the
      // resulting Git tree against HEAD and refuses empty/no-op commits.
      // Explicit push:false is independent of the manual Push checkbox.
      const result = await vscode.commands.executeCommand('sweetiebot.queueCommit', root, {
        all: true,
        codex: false,
        trailer,
        push: false
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
  const busy = new Set();
  const reported = new Map();
  let scanning = false;
  let disposed = false;
  const scan = async () => {
    if (scanning || disposed) return;
    scanning = true;
    try {
      await scanAutoCodexCommits(vscode, busy, reported);
    } catch (error) {
      console.warn('Sweetiebot automatic Codex commit scan:', error);
    } finally {
      scanning = false;
    }
  };
  // First automatic check happens after a full interval, not on activation.
  const timer = setInterval(() => { void scan(); }, AUTO_COMMIT_INTERVAL_MS);
  context.subscriptions.push({ dispose() {
    disposed = true;
    clearInterval(timer);
  } });
}

module.exports = { AUTO_COMMIT_INTERVAL_MS, hasPendingChanges, scanAutoCodexCommits, registerAutoCodexCommit };
