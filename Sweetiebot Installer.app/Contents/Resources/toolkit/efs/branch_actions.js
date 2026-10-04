'use strict';

async function returnHome(repository) {
  await repository.checkout('main');
  await repository.status();
  if (repository.state.HEAD?.name !== 'main') {
    throw new Error('Could not switch to main.');
  }
  return 'main';
}

async function syncDefaultBranch(repository, defaultBranch, remote) {
  await repository.checkout(defaultBranch);
  await repository.status();
  if (repository.state.HEAD?.name !== defaultBranch) {
    throw new Error(`Could not switch to ${defaultBranch}.`);
  }
  const upstream = repository.state.HEAD.upstream;
  if (!upstream || upstream.remote !== remote) {
    throw new Error(`${defaultBranch} must track a branch on ${remote} before syncing.`);
  }
  await repository.pull();
  await repository.status();
  if (repository.state.HEAD?.name !== defaultBranch) {
    throw new Error(`The active branch changed while syncing ${defaultBranch}.`);
  }
  if (repository.state.HEAD.ahead > 0) {
    await repository.push(remote, `${defaultBranch}:${upstream.name}`);
  }
}

async function createBranch(repository, { defaultBranch, remote, names }, random = Math.random) {
  if (!names?.length) throw new Error('No pony branch names are configured.');
  await syncDefaultBranch(repository, defaultBranch, remote);
  const refs = await repository.getRefs({ pattern: ['refs/heads', `refs/remotes/${remote}`] });
  const used = new Set(refs.flatMap(ref => [
    ref.name,
    ref.name?.startsWith(`${remote}/`) ? ref.name.slice(remote.length + 1) : ref.name
  ]));
  const available = [...new Set(names)].filter(name => !used.has(name));
  if (!available.length) throw new Error('All configured pony branch names are already in use.');
  const branch = available[Math.floor(random() * available.length)];
  await repository.createBranch(branch, true, 'HEAD');
  return branch;
}

async function publishBranch(repository, { branch, remote }) {
  if (!branch) throw new Error('No branch was supplied for publishing.');
  await repository.status();
  const head = repository.state.HEAD;
  if (head?.name !== branch) {
    throw new Error('The active branch changed before it could be published.');
  }
  if (head.upstream) return false;
  await repository.push(remote, branch, true);
  return true;
}

async function deleteBranch(repository, { branch, defaultBranch, remote }) {
  if (!branch || branch === defaultBranch) throw new Error(`Cannot delete ${defaultBranch}.`);
  await repository.status();
  if (repository.state.HEAD?.name !== branch) {
    throw new Error('The active branch changed; select the branch to delete again.');
  }
  await repository.fetch({ remote, prune: true });
  const refs = await repository.getRefs({ pattern: `refs/remotes/${remote}` });
  if (!refs.length) throw new Error(`Cannot delete ${branch}: ${remote} could not be verified.`);
  if (refs.some(ref => ref.name === `${remote}/${branch}`)) {
    throw new Error(`Cannot delete ${branch}: it still exists on ${remote}.`);
  }
  await syncDefaultBranch(repository, defaultBranch, remote);
  await repository.deleteBranch(branch, false);
  return branch;
}

async function syncBranch(repository, { branch, defaultBranch, remote }) {
  if (!branch || branch === defaultBranch) throw new Error(`Cannot sync ${defaultBranch} into itself.`);
  const checkBranch = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== branch) {
      throw new Error('The active branch changed; select the branch to sync again.');
    }
  };
  await checkBranch();
  await repository.fetch({ remote });
  await checkBranch();
  const previousMessage = repository.inputBox.value;
  const message = `🔄 Sync branch with ${defaultBranch}`;
  repository.inputBox.value = message;
  try {
    await repository.merge(`${remote}/${defaultBranch}`);
  } finally {
    await repository.status();
    if (!repository.state.mergeChanges.length && repository.inputBox.value === message) {
      repository.inputBox.value = previousMessage;
    }
  }
  return branch;
}

function registerBranchCommands(vscode, context) {
  for (const [command, action] of [
    ['scmToolkit.returnHome', returnHome],
    ['scmToolkit.createBranch', createBranch],
    ['scmToolkit.publishBranch', publishBranch],
    ['scmToolkit.deleteBranch', deleteBranch],
    ['scmToolkit.syncBranch', syncBranch]
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (uri, options) => {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) throw new Error('The VS Code Git extension is unavailable.');
      const git = await extension.activate();
      // Built-in Git status-bar commands pass a SourceControl, not a Uri.
      // Resolve its root before calling the public Git API.
      // Workbench command arguments cross the extension-host boundary as data.
      // The Git API requires a real extension-host Uri instance.
      const repositoryUri = vscode.Uri.from(uri?.rootUri ?? uri);
      const repository = git.getAPI(1).getRepository(repositoryUri);
      if (!repository) throw new Error('The selected Git repository is unavailable.');
      return action(repository, options);
    }));
  }
}

module.exports = { returnHome, createBranch, publishBranch, deleteBranch, syncBranch, registerBranchCommands };
