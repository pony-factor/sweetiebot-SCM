'use strict';

const path = require('node:path');
const { realpathSync } = require('node:fs');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const switchingEditors = new WeakSet();
const openingHandoffEditors = new WeakMap();

async function duringEditorCheckoutSwitch(vscode, work) {
  switchingEditors.add(vscode);
  try { return await work(); }
  finally { switchingEditors.delete(vscode); }
}

// VS Code keeps the path it opened, while Git routing uses a real path.
// Resolve the nearest existing parent for deleted and as-yet unsaved files.
function resolveEditorPath(location) {
  const suffix = [];
  while (true) {
    try {
      return path.join(realpathSync.native(location), ...suffix);
    } catch { /* The document may only exist in memory. */ }
    const parent = path.dirname(location);
    if (parent === location) return null;
    suffix.unshift(path.basename(location));
    location = parent;
  }
}

function relativeFile(root, uri) {
  if (uri?.scheme !== 'file' || typeof uri.fsPath !== 'string') return null;
  const relativeToRoot = location => {
    const relative = path.relative(root, location);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? relative : null;
  };
  const relative = relativeToRoot(uri.fsPath);
  if (relative) return relative;
  const resolved = resolveEditorPath(uri.fsPath);
  return resolved ? relativeToRoot(resolved) : null;
}

function localFile(uri) {
  if (uri?.scheme === 'file') return uri;
  if (uri?.scheme === 'git') {
    try {
      const fsPath = JSON.parse(uri.query).path;
      if (typeof fsPath === 'string' && path.isAbsolute(fsPath)) return { scheme: 'file', fsPath };
    } catch { /* Other virtual documents retain their identity. */ }
  }
  return undefined;
}

async function allowCheckoutEditor(vscode, resources, run = async (root, args) =>
  (await exec('git', ['-C', root, ...args], { timeout: 5000 })).stdout) {
  if (switchingEditors.has(vscode) || !vscode.workspace.getConfiguration('sweetiebot').get('singleRepositoryPerWindow', true)) return true;
  const transition = openingHandoffEditors.get(vscode);
  const files = resources.map(localFile).filter(uri => uri && !transition?.has(uri.fsPath));
  if (!files.length) return true;
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') || [];
  const repository = vscode.extensions?.getExtension('vscode.git')?.exports?.getAPI(1)?.repositories?.[0];
  let root = repository?.rootUri?.fsPath;
  if (root && !folders.some(({ uri }) => root === uri.fsPath || relativeFile(root, uri) ||
      relativeFile(uri.fsPath, { scheme: 'file', fsPath: root }))) root = undefined;
  if (!root) {
    for (const folder of folders) {
      root = (await run(folder.uri.fsPath, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
      if (root) break;
    }
  }
  if (root) root = resolveEditorPath(root);
  if (!root) return true;
  const outside = files.filter(uri => relativeFile(root, uri) === null);
  if (!outside.length) return true;
  const listing = await run(root, ['worktree', 'list', '--porcelain', '-z']);
  const worktrees = listing.split('\0\0').map(record => {
    const fields = record.split('\0');
    return {
      root: fields[0]?.startsWith('worktree ') ? resolveEditorPath(fields[0].slice(9)) : null,
      branch: fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18),
    };
  });
  const selected = worktrees.find(worktree => worktree.root === root);
  for (const file of outside) {
    const worktree = worktrees.find(other => other.root && other.root !== root && relativeFile(other.root, file) !== null);
    if (!worktree) continue;
    const branch = worktree.branch ? 'the ' + worktree.branch + ' worktree' : 'a different worktree';
    void vscode.window.showWarningMessage('Blocked ' + path.basename(file.fsPath) + ' from ' + branch + '. ' +
      (selected?.branch ? 'This window is on ' + selected.branch + '. ' : '') +
      'Open it in a window on that checkout.');
    return false;
  }
  return true;
}

// Save only this repository's documents. saveAll would also write unrelated
// workspaces and untitled drafts. A cancelled/failed save must stop the fork.
async function saveRepositoryDocuments(vscode, root) {
  for (const document of [...(vscode.workspace.textDocuments || []), ...(vscode.workspace.notebookDocuments || [])]) {
    if (relativeFile(root, document.uri) === null || !document.isDirty) continue;
    if (!await document.save() || document.isDirty)
      throw new Error('Save the repository’s open files before switching worktrees; the checkout was preserved.');
  }
}

function assertSavedRepositoryDocuments(vscode, root) {
  if ([...(vscode.workspace.textDocuments || []), ...(vscode.workspace.notebookDocuments || [])].some(document =>
    document.isDirty && relativeFile(root, document.uri) !== null)) {
    throw new Error('An open file changed during worktree handoff; its unsaved edits were preserved.');
  }
}

async function moveRepositoryEditors(vscode, root, destination, { existingOnly = false, isCurrent = () => true } = {}) {
  const groups = vscode.window?.tabGroups;
  if (!groups?.all || typeof groups.close !== 'function') return [];
  if (!existingOnly) assertSavedRepositoryDocuments(vscode, root);
  const move = uri => {
    const relative = relativeFile(root, uri);
    if (relative !== null) return vscode.Uri.file(path.join(destination, relative));
    // Git diff editors encode their backing file in both the path and query.
    if (uri?.scheme === 'git' && typeof uri.with === 'function') {
      try {
        const query = JSON.parse(uri.query);
        const relative = relativeFile(root, { scheme: 'file', fsPath: query.path });
        if (relative !== null) {
          const target = path.join(destination, relative);
          return uri.with({ path: vscode.Uri.file(target).path, query: JSON.stringify({ ...query, path: target }) });
        }
      } catch { /* Other virtual documents retain their identity. */ }
    }
    return uri;
  };
  const plans = [];
  for (const group of groups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!input || (existingOnly && tab.isDirty)) continue;
      const options = { viewColumn: group.viewColumn, preview: tab.isPreview,
        preserveFocus: true };
      if (input.original && input.modified) {
        const original = move(input.original), modified = move(input.modified);
        if (original !== input.original || modified !== input.modified)
          plans.push({ tab, original, modified, options,
            targets: [original !== input.original && original, modified !== input.modified && modified].filter(Boolean) });
      } else if (relativeFile(root, input.uri) !== null) {
        const uri = move(input.uri);
        const editor = (vscode.window.visibleTextEditors || []).find(editor =>
          editor.viewColumn === group.viewColumn && editor.document.uri.fsPath === input.uri.fsPath);
        if (editor) options.selection = editor.selection;
        plans.push({ tab, uri, viewType: input.viewType, options, targets: [uri] });
      }
    }
  }
  // Open the replacements first. If an editor provider refuses the new URI,
  // the source tabs and their documents remain available for recovery.
  // Reopen each group's selected tab last without stealing composer focus.
  plans.sort((a, b) => Number(!!a.tab.isActive) - Number(!!b.tab.isActive));
  const assertSavedTabs = () => {
    if (plans.some(plan => plan.tab.isDirty))
      throw new Error('Save the repository’s open file editors before switching worktrees; their tabs were preserved.');
  };
  if (existingOnly) {
    for (const { tab, targets, ...editor } of plans) {
      const exists = await Promise.all(targets.map(async uri => {
        try {
          const location = uri.scheme === 'git' ? JSON.parse(uri.query).path : uri.fsPath;
          return relativeFile(destination, { scheme: 'file', fsPath: await fs.realpath(location) }) !== null
            && (await fs.stat(location)).isFile();
        } catch { return false; }
      }));
      if (!isCurrent()) return [];
      const stillOpen = () => groups.all.some(group => group.tabs.includes(tab));
      if (!exists.every(Boolean) || tab.isDirty || !stillOpen()) continue;
      await openEditor(vscode, editor);
      if (isCurrent() && !tab.isDirty && stillOpen()) await groups.close([tab], true);
    }
    return [];
  }
  assertSavedTabs();
  const editors = plans.map(({ tab, targets, ...editor }) => editor);
  try {
    for (const editor of editors) {
      const resources = [editor.uri, editor.original, editor.modified].map(localFile).filter(Boolean);
      openingHandoffEditors.set(vscode, new Set(resources.map(uri => uri.fsPath)));
      await openEditor(vscode, editor);
    }
  } finally {
    openingHandoffEditors.delete(vscode);
  }
  assertSavedRepositoryDocuments(vscode, root);
  assertSavedTabs();
  // Opening a preview can already have replaced its original preview tab.
  const remaining = plans.map(plan => plan.tab).filter(tab => groups.all.some(group => group.tabs.includes(tab)));
  if (remaining.length && !await groups.close(remaining, true))
    throw new Error('Could not close the original file editors; the workspace was preserved.');
  return editors;
}

function openEditor(vscode, { uri, original, modified, viewType, options }) {
  if (original) return vscode.commands.executeCommand('vscode.diff', original, modified, undefined, options);
  if (viewType) return vscode.commands.executeCommand('vscode.openWith', uri, viewType, options);
  return vscode.commands.executeCommand('vscode.open', uri, options);
}

function registerEditorWorkspaceHandoff(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.allowCheckoutEditor',
    resources => allowCheckoutEditor(vscode, resources)));
  const key = workspace => 'sweetiebot.editorHandoff.' + workspace;
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.editorHandoff.save', (workspace, editors) => {
    const stored = editors?.map(({ options, ...editor }) => {
      const { selection, ...openOptions } = options;
      return { ...editor, options: openOptions,
        selection: selection && [selection.start.line, selection.start.character, selection.end.line, selection.end.character] };
    });
    return context.globalState.update(key(workspace), stored);
  }));
  const workspace = vscode.workspace.workspaceFile?.fsPath;
  const editors = workspace && context.globalState.get(key(workspace));
  if (!editors?.length) return;
  setImmediate(async () => {
    try {
      await context.globalState.update(key(workspace), undefined);
      for (const { uri, original, modified, viewType, options, selection } of editors) {
        if (selection) options.selection = new vscode.Range(...selection);
        await openEditor(vscode, {
          uri: uri && vscode.Uri.from(uri), original: original && vscode.Uri.from(original),
          modified: modified && vscode.Uri.from(modified), viewType, options
        });
      }
    } catch (error) {
      void vscode.window.showWarningMessage('Could not restore the branch’s open editors: ' + error.message);
    }
  });
}

module.exports = { saveRepositoryDocuments, assertSavedRepositoryDocuments, moveRepositoryEditors,
  registerEditorWorkspaceHandoff, allowCheckoutEditor, duringEditorCheckoutSwitch };
