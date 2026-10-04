'use strict';

const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

async function cleanupMergedBranch(repository, branch) {
  const installedScript = path.join(__dirname, 'prune_merged_branches.py');
  const script = existsSync(installedScript) ? installedScript : path.join(__dirname, '../scripts/prune_merged_branches.py');
  await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', [
    script, '--force', '--repo', repository.rootUri.fsPath, `--branch=${branch}`
  ], { timeout: 120000 });
}

async function returnHome(repository) {
  await repository.checkout('main');
  await repository.status();
  if (repository.state.HEAD?.name !== 'main') {
    throw new Error('Could not switch to main.');
  }
  return 'main';
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n');
}

async function retryConnection(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !/timed? out|timeout|connection (?:reset|closed)|could not resolve host|failed to connect|HTTP (?:502|503|504)|requested URL returned error: (?:502|503|504)/i.test(errorText(error))) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function syncDefaultBranch(repository, defaultBranch, remote) {
  await repository.checkout(defaultBranch);
  const checkBranch = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== defaultBranch) {
      throw new Error(`Could not switch to ${defaultBranch}, or the active branch changed while syncing it.`);
    }
  };
  await checkBranch();
  const upstream = repository.state.HEAD.upstream;
  if (!upstream || upstream.remote !== remote) {
    throw new Error(`${defaultBranch} must track a branch on ${remote} before syncing.`);
  }
  for (let attempt = 0; ; attempt++) {
    // Fetch and merge explicitly: VS Code's throttled pull can retain a failed
    // queued request after a timeout, preventing later attempts from running.
    await retryConnection(async () => {
      await checkBranch();
      await repository.fetch({ remote });
    });
    await checkBranch();
    await repository.merge(`${remote}/${upstream.name}`);
    await checkBranch();
    if (!repository.state.HEAD.ahead) return;
    try {
      await retryConnection(async () => {
        await checkBranch();
        await repository.push(remote, `${defaultBranch}:${upstream.name}`);
      });
      await checkBranch();
      return;
    } catch (error) {
      // Another writer can advance the remote between fetching and pushing.
      // Merge their changes before retrying; never force-push or rebase.
      if (attempt >= 2 || !/non-fast-forward|fetch first|tip of your current branch is behind/i.test(errorText(error))) {
        throw error;
      }
    }
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

async function deleteBranch(repository, { branch, defaultBranch, remote }, cleanup = cleanupMergedBranch) {
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
  try {
    await repository.deleteBranch(branch, false);
  } catch (error) {
    const stillExists = async () => (await repository.getRefs({ pattern: 'refs/heads' }))
      .some(ref => ref.name === branch);
    // Automatic cleanup may have removed the branch after checkout.
    if (!await stillExists()) return branch;
    if (error?.gitErrorCode !== 'BranchNotFullyMerged' && !/not fully merged/i.test(errorText(error))) {
      throw error;
    }
    // Squash merges do not satisfy Git's ancestry check. Reuse cleanup's
    // GitHub PR verification and atomic tip check rather than force-delete.
    await cleanup(repository, branch);
    if (await stillExists()) {
      throw new Error(`Cannot delete ${branch}: its current tip could not be verified as a merged pull request. The branch was preserved; you are now on ${defaultBranch}.`);
    }
    await repository.status();
  }
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
