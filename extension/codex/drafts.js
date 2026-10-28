'use strict';

const { createHash } = require('node:crypto');

// Drafts are per checkout/workspace, not per VS Code window or Codex account.
// A single globalState key per scope avoids whole-map lost updates when several
// independent VS Code extension hosts save concurrently.
function codexDraftStorageKey(vscode) {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = folders.map(folder => folder.uri?.toString?.(true)).filter(Boolean).sort();
  if (!roots.length) return undefined;
  const hash = createHash('sha256').update(JSON.stringify(roots)).digest('hex');
  return `sweetiebot.codexDraft.v1.${hash}`;
}

function registerCodexDraftCommands(vscode, context) {
  const key = codexDraftStorageKey(vscode);
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexDraft.read', () => {
    if (!key) return { enabled: false };
    const saved = context.globalState.get(key);
    return { enabled: true, draft: typeof saved === 'string' ? saved : null };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexDraft.write', async draft => {
    if (!key) return false;
    if (draft !== null && (typeof draft !== 'string' || draft.length > 2000000)) {
      throw new Error('Invalid Codex composer draft.');
    }
    await context.globalState.update(key, draft === null || draft === '' ? undefined : draft);
    return true;
  }));
}

module.exports = { codexDraftStorageKey, registerCodexDraftCommands };
