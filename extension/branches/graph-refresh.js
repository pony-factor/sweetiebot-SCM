'use strict';

// A Source Control graph opened before Git has scanned the workspace can stay
// empty. Linked worktrees can also be discovered before their history provider
// has finished initializing, so a successful first status is not always enough.
async function registerGraphStartupRefresh(vscode, context, { retryDelayMs = 1500,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  // Git's API creates fresh wrappers for the same underlying repository. Key
  // scans by the worktree root, not wrapper identity, to keep retries bounded.
  const scans = new Map();
  const timers = new Map();
  let disposed = false;

  const repositoryKey = repository => repository?.rootUri?.fsPath || repository?.rootUri?.toString?.();
  const schedule = (repository, key) => {
    if (disposed || timers.has(key)) return;
    const timer = setTimer(() => {
      timers.delete(key);
      void refresh(repository);
    }, retryDelayMs);
    timer?.unref?.();
    timers.set(key, timer);
  };

  const refresh = async repository => {
    const key = repositoryKey(repository);
    if (disposed || !key || repository.rootUri.scheme !== 'file') return;
    const state = scans.get(key) || { attempts: 0, active: false, complete: false };
    if (state.active || state.complete || state.attempts >= 3) return;
    scans.set(key, state);
    state.active = true;
    const attempt = ++state.attempts;
    try {
      // Use this repository's API to avoid git.refresh's repository picker and
      // preserve the selected branch, worktree and other Git preferences.
      await repository.status();
      if (disposed || scans.get(key) !== state) return;
      // An early successful status may precede HEAD discovery. The Git API's
      // worktree history provider may also attach only after that first scan.
      const missingHead = repository.state && !repository.state.HEAD?.commit;
      if (attempt < 3 && (missingHead || (repository.kind === 'worktree' && attempt === 1))) {
        schedule(repository, key);
      } else {
        state.complete = true;
      }
    } catch {
      // The initial Git scan may race repository discovery. Retry briefly,
      // without making ordinary Git operations or the SCM view depend on us.
      if (!disposed && scans.get(key) === state && attempt < 3) schedule(repository, key);
    } finally {
      state.active = false;
    }
  };

  context.subscriptions.push({ dispose() {
    disposed = true;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    scans.clear();
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
  if (typeof api.onDidCloseRepository === 'function') {
    context.subscriptions.push(api.onDidCloseRepository(repository => {
      const key = repositoryKey(repository);
      if (!key) return;
      scans.delete(key);
      if (timers.has(key)) clearTimer(timers.get(key));
      timers.delete(key);
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
