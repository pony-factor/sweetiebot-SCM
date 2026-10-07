'use strict';

const path = require('path');

const COMMAND_ID = 'sweetiebot.openFileOnGitHub';

function remoteWebBase(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value) return '';

  let host = '';
  let pathname = '';
  if (/^(?:https?|ssh|git):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      host = parsed.host;
      pathname = parsed.pathname;
    } catch {
      return '';
    }
  } else {
    const scp = value.match(/^(?:[^@\s]+@)?([^:\s]+):(.+)$/);
    if (!scp) return '';
    host = scp[1];
    pathname = scp[2];
  }

  const repository = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !repository || !repository.includes('/')) return '';
  return `https://${host}/${repository.split('/').map(encodeURIComponent).join('/')}`;
}

function githubFileUrl(remoteUrl, ref, relativePath) {
  const base = remoteWebBase(remoteUrl);
  const revision = String(ref || '').trim();
  const file = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!base || !revision || !file || file.startsWith('../')) return '';
  const encodedRef = revision.split('/').map(encodeURIComponent).join('/');
  const encodedFile = file.split('/').map(encodeURIComponent).join('/');
  return `${base}/blob/${encodedRef}/${encodedFile}`;
}

function selectedUri(vscode, target) {
  const candidate = target?.resourceUri || target?.uri || target;
  if (candidate?.scheme === 'file' && candidate.fsPath) return candidate;
  return vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
    ? vscode.window.activeTextEditor.document.uri
    : undefined;
}

function repositoryForUri(git, uri) {
  if (typeof git.getRepository === 'function') {
    const repository = git.getRepository(uri);
    if (repository) return repository;
  }
  const filePath = path.resolve(uri.fsPath);
  return (git.repositories || []).find(repository => {
    const root = path.resolve(repository.rootUri.fsPath);
    const relative = path.relative(root, filePath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) || relative === '';
  });
}

async function openFileOnGitHub(vscode, target) {
  const uri = selectedUri(vscode, target);
  if (!uri) throw new Error('Select a local file to open on GitHub.');

  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) throw new Error('The built-in Git extension is unavailable.');
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const git = exports?.getAPI?.(1);
  if (!git) throw new Error('The built-in Git extension is unavailable.');

  const repository = repositoryForUri(git, uri);
  if (!repository) throw new Error('The selected file is not inside a Git repository.');

  const head = repository.state?.HEAD || {};
  const ref = head.upstream?.name || head.name || head.commit;
  const preferredRemote = head.upstream?.remote || 'origin';
  const remotes = repository.state?.remotes || [];
  const remote = remotes.find(item => item.name === preferredRemote)
    || remotes.find(item => item.name === 'origin')
    || remotes[0];
  const remoteUrl = remote?.fetchUrl || remote?.pushUrl;
  if (!remoteUrl) throw new Error('This repository does not have a remote to open on GitHub.');

  const relative = path.relative(repository.rootUri.fsPath, uri.fsPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Select a file inside the current Git repository.');
  }
  const url = githubFileUrl(remoteUrl, ref, relative);
  if (!url) throw new Error('Unable to build a GitHub URL for the selected file.');
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return url;
}

function registerOpenFileOnGitHub(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_ID, async target => {
    try {
      return await openFileOnGitHub(vscode, target);
    } catch (error) {
      vscode.window.showErrorMessage(`Open File on GitHub: ${error.message}`);
      return undefined;
    }
  }));
}

module.exports = { COMMAND_ID, remoteWebBase, githubFileUrl, repositoryForUri, openFileOnGitHub, registerOpenFileOnGitHub };
