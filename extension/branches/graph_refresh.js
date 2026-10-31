'use strict';

// A Source Control graph opened before Git has scanned the workspace can stay
// empty until another Git command forces a status read. Refresh each repository
// once on startup and when Git discovers additional workspace repositories.
async function registerGraphStartupRefresh(vscode, context, { retryDelayMs = 1500,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const completed = new WeakSet();
  const active = new WeakSet();
  const attempts = new WeakMap();
  const timers = new Set();
  let disposed = false;

  const refresh = async repository => {
    if (disposed || !repository?.rootUri || repository.rootUri.scheme !== 'file' ||
        completed.has(repository) || active.has(repository)) return;
    const attempt = (attempts.get(repository) || 0) + 1;
    if (attempt > 3) return;
    active.add(repository);
    attempts.set(repository, attempt);
    try {
      // Using this repository's API avoids git.refresh's repository picker and
      // preserves the selected branch, working tree and other Git preferences.
      await repository.status();
      if (!disposed) completed.add(repository);
    } catch {
      // The initial Git scan may race repository discovery. Retry briefly,
      // without making ordinary Git operations or the SCM view depend on us.
      if (!disposed && attempt < 3) {
        const timer = setTimer(() => {
          timers.delete(timer);
          void refresh(repository);
        }, retryDelayMs);
        timer?.unref?.();
        timers.add(timer);
      }
    } finally {
      active.delete(repository);
    }
  };

  context.subscriptions.push({ dispose() {
    disposed = true;
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  } });

  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const git = await extension.activate();
  if (disposed) return;
  const api = git.getAPI(1);
  if (typeof api.onDidOpenRepository === 'function') {
    context.subscriptions.push(api.onDidOpenRepository(repository => {
      void refresh(repository);
    }));
  }
  if (typeof vscode.workspace?.onDidChangeWorkspaceFolders === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void Promise.all((api.repositories || []).map(refresh));
    }));
  }
  await Promise.all((api.repositories || []).map(refresh));
}

module.exports = { registerGraphStartupRefresh };
