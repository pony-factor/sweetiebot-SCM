'use strict';

const { spawn, execFile } = require('node:child_process');
const { resolvePythonExecutable, pythonLaunchError } = require('./python_runtime');
const { mergedBranchStatus, warnMergedBranch } = require('./merged_branch');

function enqueue(script, cwd, request, action = '--enqueue') {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), [script, action], {
      cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => {
      // Do not kill a child after it may have durably accepted the job.
      reject(new Error('Background commit acknowledgement timed out. Check the saved job before retrying.'));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('error', error => { clearTimeout(timeout); reject(pythonLaunchError(error)); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Could not queue the background commit.'));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function readStatus(script, cwd) {
  return new Promise(resolve => {
    execFile(resolvePythonExecutable(), [script, '--status'], { cwd, timeout: 10000 },
      (error, stdout) => {
        try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}

function blockedNotification(root, status) {
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const conflict = /merge conflicts?/i.test(status.error || '');
  const files = Array.isArray(status.conflictPaths) ? status.conflictPaths : [];
  const branch = status.branch?.replace(/^refs\/heads\//, '');
  const label = name + (branch ? ' (' + branch + ')' : '');
  const count = files.length ? ` in ${files.length} file${files.length === 1 ? '' : 's'}` : '';
  return {
    message: conflict
      ? `${label}: Push blocked by merge conflicts${count}. Lindsey could not sync this branch.`
      : `${label}: Commit & Push paused. ${status.error || 'The background job needs attention.'}`,
    action: conflict ? 'View conflicting files' : 'View details',
    detail: [
      'Repository: ' + root, ...(branch ? ['Branch: ' + branch] : []), '',
      ...(conflict ? ['Push blocked: local and remote changes conflict.', '',
        ...files.map(file => '  • ' + file), ...(files.length ? [''] : [])] : []),
      status.error || '', '',
      'Retry sync and push after resolving the problem.',
      'Stop background push keeps your local commit and stops this queued push.'
    ].join('\n')
  };
}

function registerBackgroundCommit(vscode, context) {
  const script = vscode.Uri.joinPath(context.extensionUri, 'background_commit.py').fsPath;
  const resume = () => {
    const child = spawn(resolvePythonExecutable(), [script, '--resume'], {
      detached: true, stdio: 'ignore'
    });
    child.on('error', () => {});
    child.unref();
  };
  resume();
  const control = (root, action) => {
    seen.delete(root);
    const child = spawn(resolvePythonExecutable(), [script, '--' + action], {
      cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { void vscode.window.showErrorMessage(pythonLaunchError(error).message); });
    child.on('close', code => {
      if (code) void vscode.window.showErrorMessage(stderr.trim() || 'Could not update background job.');
    });
    child.unref();
  };
  let scanning = false;
  const seen = new Map();
  let output;
  const generation = new Map();
  const generationRevision = new Map();
  const pendingPushes = new Set();
  let pushing;
  const setPushPending = async (root, pending) => {
    if (pending) pendingPushes.add(root);
    else pendingPushes.delete(root);
    const value = pendingPushes.size > 0;
    if (value === pushing) return;
    await vscode.commands.executeCommand('setContext', 'sweetiebot.pushPending', value);
    pushing = value;
  };
  const showGeneration = root => {
    if (generation.has(root)) return;
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    // Keep this entry until generation ends so polling cannot reopen the toast.
    const timer = setTimeout(finish, 1000);
    generation.set(root, { finish, timer });
    void vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Generating commit message asynchronously', cancellable: false
    }, () => pending).catch(() => {});
  };
  const closeGeneration = root => {
    const notice = generation.get(root);
    if (notice) {
      clearTimeout(notice.timer);
      notice.finish();
    }
    generation.delete(root);
  };
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) return;
      const git = await extension.activate();
      const repositories = git.getAPI(1).repositories || [];
      const roots = new Set(repositories.map(repository => repository.rootUri.fsPath));
      for (const root of pendingPushes) {
        if (!roots.has(root)) await setPushPending(root, false);
      }
      for (const repository of repositories) {
        const root = repository.rootUri.fsPath;
        const revision = generationRevision.get(root);
        const status = await readStatus(script, root);
        if (!status) continue;
        if (revision === generationRevision.get(root)) {
          await setPushPending(root, status.pushPending === true);
          if (status.titleJobs?.length) showGeneration(root);
          else closeGeneration(root);
        }
        const previous = seen.get(root);
        seen.set(root, status.id ? status : undefined);
        if (status.recoverable) {
          if (!previous?.recoverable || previous.id !== status.id) resume();
        } else if (status.phase === 'blocked'
            && (previous?.phase !== 'blocked' || previous?.recoverable || previous?.id !== status.id)) {
          if (status.mergedBranch) {
            void warnMergedBranch(vscode, repository, status.mergedBranch).catch(error =>
              vscode.window.showErrorMessage(error.message));
            continue;
          }
          const notice = blockedNotification(root, status);
          void vscode.window.showErrorMessage(notice.message,
            notice.action, 'Retry sync and push', 'Stop background push').then(choice => {
              if (choice === notice.action) {
                if (!output) {
                  output = vscode.window.createOutputChannel('Commit & Push problems');
                  context.subscriptions.push(output);
                }
                output.appendLine(notice.detail + '\n');
                output.show(true);
              }
              if (choice === 'Retry sync and push') control(root, 'retry');
              if (choice === 'Stop background push') control(root, 'cancel');
            });
        } else if (status.phase === 'pushing' && previous?.phase !== 'pushing') {
          const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
          void vscode.window.showInformationMessage(`${name}: Push is pending and will retry automatically.`);
        } else if (previous?.id && !status.id) {
          await repository.status();
        }
      }
    } finally { scanning = false; }
  };
  const timer = setInterval(() => { void scan().catch(() => {}); }, 10000);
  context.subscriptions.push({ dispose() {
    clearInterval(timer);
    for (const root of generation.keys()) closeGeneration(root);
    pendingPushes.clear();
    void vscode.commands.executeCommand('setContext', 'sweetiebot.pushPending', false);
  } });
  void scan().catch(() => {});
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.queuePush', async (uri, options = {}) => {
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    if (root.scheme !== 'file') return { queued: false };
    const merged = await mergedBranchStatus({ rootUri: root }, options.remote, options.branch);
    if (merged) {
      await warnMergedBranch(vscode, { rootUri: root }, merged);
      return { queued: false, cancelled: true };
    }
    const result = await enqueue(script, root.fsPath, options, '--request-push');
    if (result.queued) {
      generationRevision.set(root.fsPath, (generationRevision.get(root.fsPath) || 0) + 1);
      await setPushPending(root.fsPath, true);
      void vscode.window.showInformationMessage(
        'Commit message generation is in progress. Your changes will be pushed as soon as it completes.');
    }
    return result;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.queueCommit', async (uri, options = {}) => {
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    if (root.scheme !== 'file') throw new Error('Background commits need a local repository.');
    if (options.onlyIfPending) {
      const status = await readStatus(script, root.fsPath);
      if (!status) throw new Error('Could not check the background commit queue.');
      if (!status.id) return { queued: false };
    }
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(root);
    if (!repository) throw new Error('The selected repository is unavailable.');
    const config = vscode.workspace.getConfiguration('git', root);
    const pushing = options.push ?? config.get('postCommitCommand') === 'push';
    const remote = vscode.workspace.getConfiguration('scmToolkit', root).get('remote', 'origin');
    // Overlap independent local status refresh with the network-backed
    // merged-branch safeguard instead of serializing both before the commit.
    const [, merged] = await Promise.all([
      repository.status(),
      pushing ? mergedBranchStatus(repository, remote) : Promise.resolve(null)
    ]);
    if (merged) {
      await warnMergedBranch(vscode, repository, merged);
      return { cancelled: true };
    }
    if (repository.state.mergeChanges.length) throw new Error('Resolve conflicts before queuing a commit.');
    if (!repository.state.indexChanges.length || options.all) {
      // Preparation reuses the fresh status and refreshes once after staging.
      await vscode.commands.executeCommand('sweetiebot.prepareCodexCommit', root, {
        all: options.all, statusFresh: true
      });
    }
    if (!repository.state.indexChanges.length) throw new Error('There are no changes to commit.');
    let snapshot = '';
    if (options.codex && options.codexCommitContext !== false && !String(options.message ?? '').trim()) {
      try {
        const codex = vscode.extensions.getExtension('openai.chatgpt');
        if (codex && !codex.isActive) await codex.activate();
        if ((await vscode.commands.getCommands(true)).includes('sweetiebot.readCodexContext')) {
          snapshot = await vscode.commands.executeCommand('sweetiebot.readCodexContext');
        }
      } catch { /* Chat context is optional; the staged tree remains authoritative. */ }
    }
    const configuration = vscode.workspace.getConfiguration('git', root);
    let result;
    // Verify the final staged selection before creating any placeholder or
    // starting title generation. If staging changes before the Python worker
    // can capture it, re-run the limit inspection on the new selection.
    for (let attempt = 0; attempt < 3; attempt++) {
      const limits = await vscode.commands.executeCommand(
        'sweetiebot.checkCommitLimits', root, { captureTree: true }
      );
      if (limits?.approved !== true || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(limits.stagedTree ?? '')) {
        return { cancelled: true };
      }
      try {
        result = await enqueue(script, root.fsPath, {
          message: options.message ?? '', context: typeof snapshot === 'string' ? snapshot.slice(-6000) : '',
          trailer: options.trailer ?? '', push: options.push ?? configuration.get('postCommitCommand') === 'push',
          sign: options.sign ?? configuration.get('enableCommitSigning') === true,
          signoff: options.signoff ?? configuration.get('alwaysSignOff') === true,
          noVerify: options.noVerify === true, expectedTree: limits.stagedTree,
          remote: vscode.workspace.getConfiguration('scmToolkit', root).get('remote', 'origin')
        });
        if (result.queued === false) {
          // The worker declined after a validated preflight. The direct Git
          // path can reuse approval only if the staged tree is still identical.
          return { ...result, preflightApproved: true, stagedTree: limits.stagedTree };
        }
        break;
      } catch (error) {
        // This specific Python failure happens before it writes a job journal
        // or creates a commit. Do not retry timeouts or uncertain Git errors:
        // those may have already created a durable local commit.
        if (!String(error?.message ?? '').startsWith(
          'Staged changes changed after the commit-size check.'
        )) throw error;
        if (attempt === 2) {
          throw new Error('Staged files changed repeatedly during commit validation. Review and retry.');
        }
        await repository.status();
        if (repository.state.mergeChanges.length) {
          throw new Error('Resolve conflicts before queuing a commit.');
        }
      }
    }
    if (result.queued) {
      generationRevision.set(root.fsPath, (generationRevision.get(root.fsPath) || 0) + 1);
      if (options.push ?? configuration.get('postCommitCommand') === 'push') {
        await setPushPending(root.fsPath, true);
      }
      await repository.status();
      if (!String(options.message ?? '').trim()) showGeneration(root.fsPath);
    }
    return result;
  }));
}

module.exports = { enqueue, readStatus, blockedNotification, registerBackgroundCommit };
