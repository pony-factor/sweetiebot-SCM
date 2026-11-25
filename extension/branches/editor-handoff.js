'use strict';

const path = require('node:path');
const { realpathSync } = require('node:fs');

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

async function moveRepositoryEditors(vscode, root, destination) {
  const groups = vscode.window?.tabGroups;
  if (!groups?.all || typeof groups.close !== 'function') return [];
  assertSavedRepositoryDocuments(vscode, root);
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
      if (!input) continue;
      const options = { viewColumn: group.viewColumn, preview: tab.isPreview,
        preserveFocus: true };
      if (input.original && input.modified) {
        const original = move(input.original), modified = move(input.modified);
        if (original !== input.original || modified !== input.modified)
          plans.push({ tab, original, modified, options });
      } else if (relativeFile(root, input.uri) !== null) {
        const uri = move(input.uri);
        const editor = (vscode.window.visibleTextEditors || []).find(editor =>
          editor.viewColumn === group.viewColumn && editor.document.uri.fsPath === input.uri.fsPath);
        if (editor) options.selection = editor.selection;
        plans.push({ tab, uri, viewType: input.viewType, options });
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
  assertSavedTabs();
  const editors = plans.map(({ tab, ...editor }) => editor);
  for (const editor of editors) await openEditor(vscode, editor);
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
  registerEditorWorkspaceHandoff };
