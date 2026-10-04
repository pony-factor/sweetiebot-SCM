'use strict';

function createPushErrorHandler() {
  // The Git API creates new Repository wrappers when invoking error handlers.
  // Key by URI so a rejected retry cannot recursively start another recovery.
  const recovering = new Set();
  return {
    async handlePushError(repository, remote, refspec, error) {
      if (error?.gitErrorCode !== 'PushRejected'
          || !/!\s+\[rejected\].*\((?:non-fast-forward|fetch first)\)/m.test(error.stderr ?? '')) {
        return false;
      }
      const key = repository.rootUri.toString();
      if (recovering.has(key)) return false;
      const head = repository.state.HEAD;
      const branch = head?.name;
      const upstream = head?.upstream;
      if (!branch || !upstream?.name || upstream.remote !== remote.name
          || refspec !== `${branch}:${upstream.name}`) return false;
      const checkBranch = async () => {
        await repository.status();
        const current = repository.state.HEAD;
        if (current?.name !== branch || current.upstream?.remote !== upstream.remote
            || current.upstream?.name !== upstream.name) {
          throw new Error('The active branch changed before its upstream changes could be merged and pushed.');
        }
      };
      recovering.add(key);
      try {
        await checkBranch();
        await repository.fetch({ remote: upstream.remote, ref: upstream.name });
        await checkBranch();
        // Preserve existing commits, regardless of pull.rebase or pull.ff settings.
        await repository.merge(`refs/remotes/${upstream.remote}/${upstream.name}`);
        await checkBranch();
        await repository.push(remote.name, refspec);
        return true;
      } finally {
        recovering.delete(key);
      }
    }
  };
}

async function registerPushRecovery(vscode, context) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const git = await extension.activate();
  context.subscriptions.push(git.getAPI(1).registerPushErrorHandler(createPushErrorHandler()));
}

module.exports = { createPushErrorHandler, registerPushRecovery };
