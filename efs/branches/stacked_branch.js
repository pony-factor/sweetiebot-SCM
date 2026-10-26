'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadBranchNameHistory, chooseBranchName, saveBranchNameHistory } = require('./branch_name_selection');
const { routeBranch } = require('./shared_main');

const executeFile = promisify(execFile);
const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
const output = result => String(result?.stdout || '').trim();
const errorText = error => String(error?.stderr || error?.message || error);

// Native GitHub stack tracking and Sweetiebot's linked worktree creation are
// separate operations. Finish stack registration before moving the workspace.
async function createStackedBranch(vscode, repository, options, dependencies = {}) {
  const { parent, defaultBranch, remote = 'origin', names = [] } = options;
  const root = repository.rootUri?.fsPath;
  if (!root || !parent || !defaultBranch || parent === defaultBranch) {
    throw new Error('Select a topic branch to create a stacked branch.');
  }
  if (!names.length) throw new Error('No pony branch names are configured.');
  const execute = dependencies.execute || executeFile;
  const run = (program, args) => execute(program, args, { cwd: root, timeout: 120000, env: environment });

  await repository.status();
  if (repository.state.HEAD?.name !== parent) {
    throw new Error('The selected parent branch changed before stack creation.');
  }
  if (repository.state.mergeChanges?.length || repository.state.indexChanges?.length
      || repository.state.workingTreeChanges?.length
      || output(await run('git', ['status', '--porcelain', '--untracked-files=all']))) {
    throw new Error('Commit or preserve pending changes and finish Git operations before creating a stacked branch.');
  }
  const startingSha = output(await run('git', ['rev-parse', '--verify', 'HEAD']));
  try {
    await run('gh', ['stack', '--help']);
  } catch {
    throw new Error('Install GitHub CLI and its gh-stack extension: gh extension install github/gh-stack');
  }
  const refs = await repository.getRefs({ pattern: ['refs/heads', `refs/remotes/${remote}`] });
  const used = new Set(refs.flatMap(ref => [
    ref.name, ref.name?.startsWith(`${remote}/`) ? ref.name.slice(remote.length + 1) : ref.name
  ]));
  const history = await (dependencies.loadHistory || loadBranchNameHistory)(repository);
  const { branch, selected } = chooseBranchName(
    [...new Set(names)].filter(name => !used.has(name)), history.selected, dependencies.randomInt
  );
  await run('git', ['check-ref-format', '--branch', branch]);
  await repository.status();
  if (repository.state.HEAD?.name !== parent
      || output(await run('git', ['rev-parse', '--verify', 'HEAD'])) !== startingSha) {
    throw new Error('The parent branch advanced while preparing the stack.');
  }

  let tracked = true;
  try {
    await run('gh', ['stack', 'view', '--json']);
  } catch (error) {
    if (!/(?:not|no) (?:\w+ )*stack|stack (?:not found|does not exist)/i.test(errorText(error))) throw error;
    tracked = false;
  }
  if (!tracked) await run('gh', ['stack', 'init', '--base', defaultBranch, parent]);

  // gh stack add checks that parent is the current top layer. It creates
  // a branch from HEAD and registers it without pushing or publishing any PR.
  try {
    await run('gh', ['stack', 'add', branch]);
  } finally {
    if (output(await run('git', ['branch', '--show-current'])) === branch) {
      await run('git', ['switch', parent]);
    }
  }
  await run('git', ['config', '--local', '--replace-all',
    `branch.${branch}.sweetiebot-stack-parent`, parent]);
  await (dependencies.saveHistory || saveBranchNameHistory)(history.file, selected);
  await repository.status();

  const openBranch = dependencies.openBranch || routeBranch;
  const routed = await openBranch(vscode, repository, { branch, adoptExisting: true });
  if (!routed) await repository.checkout(branch);
  return branch;
}

// The native linker can create its own PRs when passed raw branch names.
// Pass only VERIFIED existing PR numbers so Kafania stays the publisher.
async function linkPublishedStack(root, repositoryUrl, branch, parent, publishedUrl, dependencies = {}) {
  const prefix = `${repositoryUrl}/pull/`;
  if (!root || typeof publishedUrl !== 'string' || !publishedUrl.startsWith(prefix)
      || !/^\d+$/.test(publishedUrl.slice(prefix.length))) return false;
  const execute = dependencies.execute || executeFile;
  const run = args => execute('gh', args, { cwd: root, timeout: 120000, env: environment });
  const parentPR = JSON.parse(output(await run(['pr', 'view', parent, '--json', 'number,headRefName,state'])));
  const childPR = JSON.parse(output(await run(['pr', 'view', branch, '--json', 'number,headRefName,state'])));
  if (parentPR.headRefName !== parent || childPR.headRefName !== branch
      || parentPR.state !== 'OPEN' || childPR.state !== 'OPEN'
      || !Number.isInteger(parentPR.number) || !Number.isInteger(childPR.number)
      || childPR.number !== Number(publishedUrl.slice(prefix.length))) return false;
  await run(['stack', 'link', String(parentPR.number), String(childPR.number)]);
  return true;
}

module.exports = { createStackedBranch, linkPublishedStack };
