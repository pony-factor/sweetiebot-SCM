'use strict';

function recoveryError(error, target, step) {
  const details = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n');
  let message;
  if (/rebase.*in progress|rebase-merge|rebase-apply/i.test(details)) {
    message = 'Push paused because a rebase is in progress. Resolve its conflicts and finish or abort the rebase, then push again.';
  } else if (/not concluded your merge|MERGE_HEAD|unfinished merge/i.test(details)) {
    message = 'Push paused because a merge is unfinished. Resolve its conflicts and finish or abort the merge, then push again.';
  } else if (['Conflict', 'UnmergedChanges'].includes(error?.gitErrorCode)
      || /CONFLICT|unmerged files|merge conflict/i.test(details)) {
    message = `Push paused because merging ${target} encountered conflicts. Resolve the conflicted files, complete the merge, then push again. Your local commits are preserved.`;
  } else if (error?.gitErrorCode === 'PushRejected') {
    message = `Push paused because ${target} advanced again during recovery. Your local commits are preserved; retry Push to fetch and merge the latest changes.`;
  } else {
    const reason = details.split(/\r?\n/).map(line => line.trim()).find(line =>
      line && !/^(?:Git error|Failed to execute git)$/i.test(line));
    message = `Push paused while ${step} ${target}. Your local commits are preserved.${reason ? ` ${reason}` : ' Open Git Output for details, then retry Push.'}`;
  }
  return new Error(message, { cause: error });
}

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
      const target = `${upstream.remote}/${upstream.name}`;
      let step = 'checking the active branch before syncing';
      try {
        await checkBranch();
        step = 'fetching';
        await repository.fetch({ remote: upstream.remote, ref: upstream.name });
        await checkBranch();
        // Preserve existing commits, regardless of pull.rebase or pull.ff settings.
        step = 'merging';
        await repository.merge(`refs/remotes/${target}`);
        await checkBranch();
        step = 'pushing to';
        await repository.push(remote.name, refspec);
        return true;
      } catch (error) {
        // A plain Error lets VS Code display this explanation instead of its
        // generic Git-code notification or a single line of raw command output.
        throw recoveryError(error, target, step);
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
