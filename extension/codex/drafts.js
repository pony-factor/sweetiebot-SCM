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
  const attachmentKey = key && `${key}.attachments`;
  let draftWriting = Promise.resolve();
  let attachmentError;
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexDraft.readAttachments', () => {
    if (!attachmentKey) return { enabled: false };
    if (attachmentError) throw attachmentError;
    const workspace = vscode.workspace.workspaceFile?.fsPath;
    const pending = workspace && context.globalState.get(require('./workspace-handoff').keyFor(workspace));
    const roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const drafts = pending && roots.includes(pending.destination) && pending.attachmentDrafts &&
      require('./workspace-handoff').handoffAttachments(pending)
      || context.globalState.get(attachmentKey) || {};
    return { enabled: true, drafts };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexDraft.writeAttachments', async drafts => {
    if (!attachmentKey) return false;
    if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts) ||
        JSON.stringify(drafts).length > 32 * 1024 * 1024) {
      attachmentError = new Error('Invalid or oversized Codex attachment draft. Keep this window open; the checkout handoff is paused.');
      throw attachmentError;
    }
    try {
      await context.globalState.update(attachmentKey, drafts);
      attachmentError = undefined;
    } catch (error) { attachmentError = error; throw error; }
    return true;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexDraft.read', async () => {
    await draftWriting;
    if (!key) return { enabled: false };
    const saved = context.globalState.get(key);
    return { enabled: true, draft: saved ?? null };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexDraft.write', (draft, options = {}) => {
    if (!key) return false;
    if (draft !== null && (typeof draft !== 'string' && (!draft || typeof draft !== 'object' || Array.isArray(draft))
        || JSON.stringify(draft).length > 2000000)) {
      throw new Error('Invalid Codex composer draft.');
    }
    draftWriting = draftWriting.catch(() => {}).then(async () => {
      if (Object.prototype.hasOwnProperty.call(options, 'expectedValue') && options.expectedValue !== undefined
          && JSON.stringify(context.globalState.get(key)) !== JSON.stringify(options.expectedValue)) return false;
      await context.globalState.update(key, draft === null || draft === '' ? undefined : draft);
      return true;
    });
    return draftWriting;
  }));
}

module.exports = { codexDraftStorageKey, registerCodexDraftCommands };
