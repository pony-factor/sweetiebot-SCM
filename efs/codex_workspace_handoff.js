'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const keyFor = workspace => 'sweetiebot.codexHandoff.' + createHash('sha256').update(path.resolve(workspace)).digest('hex');

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
  const plan = await vscode.commands.executeCommand('sweetiebot.codex.prepareWorkspaceHandoff', { from });
  if (!plan) return null;
  return { ...plan, draft: typeof saved?.draft === 'string' ? saved.draft : null };
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
      const extension = vscode.extensions.getExtension('openai.chatgpt');
      if (!extension) throw new Error('Codex is unavailable in the destination window.');
      await extension.activate();
      // Consume automatic continuation before sending it. A window crash or
      // failed response must never submit the same continuation a second time.
      await context.globalState.update(key, { ...plan, wasActive: false });
      if (plan.draft !== null) await vscode.commands.executeCommand('sweetiebot.codexDraft.write', plan.draft);
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

module.exports = { prepareCodexHandoff, registerCodexWorkspaceHandoff, keyFor };
