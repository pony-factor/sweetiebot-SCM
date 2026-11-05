'use strict';

const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const keyFor = workspace => 'sweetiebot.codexHandoff.' + createHash('sha256').update(path.resolve(workspace)).digest('hex');

function handoffAttachments(plan) {
  const source = plan.source && path.resolve(plan.source);
  const destination = plan.destination && path.resolve(plan.destination);
  const move = value => {
    if (typeof value === 'string' && source && destination) {
      if (value.startsWith(source + path.sep)) return destination + value.slice(source.length);
      // Native attachment-order entries encode type/path tuples as JSON.
      if (value.startsWith('[')) {
        try { const tuple = JSON.parse(value); if (Array.isArray(tuple)) return JSON.stringify(tuple.map(move)); }
        catch { /* Other strings retain their original bytes. */ }
      }
    }
    if (Array.isArray(value)) return value.map(move);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, move(item)]));
    return value;
  };
  return move(plan.attachmentDrafts);
}

async function prepareCodexHandoff(vscode, from) {
  const extension = vscode.extensions?.getExtension('openai.chatgpt');
  if (!extension) return null;
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('sweetiebot.codex.prepareWorkspaceHandoff')) {
    throw new Error('Reload this window before switching checkouts so the same Codex chat can follow the branch.');
  }
  // Read the draft before interrupting, so a draft-provider failure leaves the worker running.
  const saved = commands.includes('sweetiebot.codexDraft.read')
    ? await vscode.commands.executeCommand('sweetiebot.codexDraft.read') : null;
  const attachments = commands.includes('sweetiebot.codexDraft.readAttachments')
    ? await vscode.commands.executeCommand('sweetiebot.codexDraft.readAttachments') : null;
  const plan = await vscode.commands.executeCommand('sweetiebot.codex.prepareWorkspaceHandoff', { from });
  const draft = saved?.draft ?? null;
  const attachmentDrafts = attachments?.enabled ? attachments.drafts : undefined;
  if (saved?.scope && attachments?.scope && saved.scope !== attachments.scope) {
    throw Error('The branch changed while capturing the Codex draft. Retry the checkout switch.');
  }
  if (!plan && !draft && !Object.keys(attachmentDrafts || {}).length) return null;
  return { ...(plan || { draftOnly: true }), source: from, draft, attachmentDrafts,
    ...(saved?.scope || attachments?.scope ? { draftScope: saved?.scope || attachments.scope, draftTransferId: randomUUID() } : {}) };
}

function registerCodexWorkspaceHandoff(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.save', async ({ workspace, plan }) => {
    await context.globalState.update(keyFor(workspace), plan);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.clear', async workspace => {
    await context.globalState.update(keyFor(workspace), undefined);
  }));
  let resuming = false;
  const resume = async () => {
    if (resuming) return;
    const workspace = vscode.workspace.workspaceFile?.fsPath;
    if (!workspace) return;
    const key = keyFor(workspace);
    const plan = context.globalState.get(key);
    if (!plan) return;
    resuming = true;
    try {
      const roots = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
      if (!roots.includes(plan.destination)) throw new Error('The saved Codex handoff does not match this workspace.');
      // Older trial windows saved a same-chat migration even though they opened
      // alongside the original. Retire only those plans before restoring drafts
      // or retrying thread/resume; the original chat and its queue stay put.
      if (plan.continuationText?.startsWith('The user moved this same chat into a disposable experiment on branch ')) {
        await context.globalState.update(key, undefined);
        return;
      }
      const extension = vscode.extensions.getExtension('openai.chatgpt');
      if (!extension) throw new Error('Codex is unavailable in the destination window.');
      await extension.activate();
      // Consume automatic continuation before sending it. A window crash or
      // failed response must never submit the same continuation a second time.
      await context.globalState.update(key, { ...plan, wasActive: false });
      if (!plan.draftsConsumed) {
        if (plan.draftScope) await vscode.commands.executeCommand('sweetiebot.codexDraft.adopt', plan);
        else {
          if (plan.draft != null) await vscode.commands.executeCommand('sweetiebot.codexDraft.write', plan.draft);
          if (plan.attachmentDrafts) await vscode.commands.executeCommand('sweetiebot.codexDraft.writeAttachments', handoffAttachments(plan));
        }
        await context.globalState.update(key, { ...plan, wasActive: false, draftsConsumed: true });
      }
      if (plan.draftOnly) {
        await context.globalState.update(key, undefined);
        return;
      }
      const result = await vscode.commands.executeCommand('sweetiebot.codex.resumeWorkspaceHandoff', plan);
      if (result?.threadId !== plan.threadId) throw new Error('The destination did not confirm the same Codex chat.');
      // Once complete, ordinary reloads must not reopen a chat the user has left.
      await context.globalState.update(key, undefined);
    } catch (error) {
      vscode.window.showErrorMessage('Codex checkout handoff is paused: ' + error.message + ' The existing chat and files are preserved.');
    } finally {
      resuming = false;
    }
  };
  // Changing the first root restarts extensions; changing another root emits
  // this event instead. Both paths must restore the same chat and draft.
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void resume()));
  setImmediate(() => void resume());
}

module.exports = { prepareCodexHandoff, registerCodexWorkspaceHandoff, keyFor, handoffAttachments };
