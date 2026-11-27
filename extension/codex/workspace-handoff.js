'use strict';

const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { handoffDraftAtoms, attachmentsAtom } = require('./drafts');
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
  const cancelCommand = commands.includes('sweetiebot.cancelCodexCapture')
    ? 'sweetiebot.cancelCodexCapture'
    : commands.includes('sweetiebot.cancelCodexShare') ? 'sweetiebot.cancelCodexShare' : null;
  if (cancelCommand) {
    try {
      await vscode.commands.executeCommand(cancelCommand);
    } catch (error) {
      // A failed transcript-copy cleanup must not veto a Git branch change.
      // Continue with the independent chat-ID and draft handoff below.
      void vscode.window?.showWarningMessage?.(
        'Codex copy cleanup was incomplete; continuing the branch switch. ' + error.message);
    }
  }
  if (!commands.includes('sweetiebot.codex.prepareWorkspaceHandoff')) {
    throw new Error('Reload this window before switching checkouts so the same Codex chat can follow the branch.');
  }
  // Read the draft before interrupting, so a draft-provider failure leaves the worker running.
  const scoped = commands.includes('sweetiebot.codexDraft.readAtoms');
  const saved = scoped ? await vscode.commands.executeCommand('sweetiebot.codexDraft.readAtoms')
    : commands.includes('sweetiebot.codexDraft.read') ? await vscode.commands.executeCommand('sweetiebot.codexDraft.read') : null;
  const attachments = !scoped && commands.includes('sweetiebot.codexDraft.readAttachments')
    ? await vscode.commands.executeCommand('sweetiebot.codexDraft.readAttachments') : null;
  if (saved?.scope && attachments?.scope && (saved.scope !== attachments.scope || saved.generation !== attachments.generation)) {
    throw Error('The branch changed while capturing the Codex draft. Retry the checkout switch.');
  }
  const plan = await vscode.commands.executeCommand('sweetiebot.codex.prepareWorkspaceHandoff', { from });
  const composerDrafts = saved?.atoms && handoffDraftAtoms(saved.atoms, plan?.threadId);
  const draft = composerDrafts && plan?.threadId ? null : saved?.draft ?? null;
  const attachmentDrafts = composerDrafts?.[attachmentsAtom] ?? (attachments?.enabled ? attachments.drafts : undefined);
  if (!plan && !draft && !Object.keys(composerDrafts || attachmentDrafts || {}).length) return null;
  return { ...(plan || { draftOnly: true }), source: from, draft, attachmentDrafts,
    ...(composerDrafts ? { composerDrafts } : {}),
    ...(saved?.scope || attachments?.scope ? { draftScope: saved?.scope || attachments.scope,
      draftGeneration: saved?.generation ?? attachments?.generation ?? 0, draftTransferId: randomUUID() } : {}) };
}

// Best-effort UI restoration is separate from the durable thread and draft handoff.
// Retry only a not-yet-hydrated composer; stop after user interaction or navigation.
async function retryCodexComposerFocus(vscode, focus, isCurrent = () => true,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  if (!focus?.state || typeof focus.state !== 'object') return false;
  const deadline = Date.now() + 60000;
  while (isCurrent() && Date.now() < deadline) {
    try {
      const restored = await vscode.commands.executeCommand('sweetiebot.codex.restoreComposerFocus', focus);
      if (restored !== null) return restored === true; // false means cancelled, not delayed
    } catch (error) {
      // A webview may be starting or replacing its composer during checkout.
      if (!/Codex composer focus restoration timed out|Codex view (?:is unavailable|closed)|Open a Codex conversation in this window first/i.test(String(error?.message || error))) return false;
    }
    if (!isCurrent() || Date.now() >= deadline) return false;
    await sleep(250);
  }
  return false;
}

function registerCodexWorkspaceHandoff(vscode, context) {
  const pending = () => {
    const workspace = vscode.workspace.workspaceFile?.fsPath;
    return workspace ? context.globalState.get(keyFor(workspace)) : undefined;
  };
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.pendingQueue', () => {
    const plan = pending();
    if (!plan?.threadId || plan.continuationText?.startsWith('The user moved this same chat into a disposable experiment on branch ')) return;
    if (!(vscode.workspace.workspaceFolders || []).some(folder => folder.uri.scheme === 'file'
      && folder.uri.fsPath === plan.destination)) return;
    return { id: plan.id, threadId: plan.threadId, turnId: plan.turnId, queuePaused: plan.queuePaused };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.save', async ({ workspace, plan }) => {
    await context.globalState.update(keyFor(workspace), plan);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.clear', async workspace => {
    await context.globalState.update(keyFor(workspace), undefined);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.consumeContinuation', async ({ workspace, id }) => {
    if (workspace !== vscode.workspace.workspaceFile?.fsPath) return false;
    const key = keyFor(workspace);
    const plan = context.globalState.get(key);
    if (!plan?.wasActive || plan.id !== id) return false;
    // Journal the attempt before submitting. A lost reply must not start another turn.
    await context.globalState.update(key, { ...plan, wasActive: false });
    return true;
  }));
  let focusGeneration = 0;
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.codexHandoff.restoreFocusWhenReady', focus => {
    const generation = ++focusGeneration;
    // Never await focus before consuming the completed handoff journal.
    void retryCodexComposerFocus(vscode, focus, () => generation === focusGeneration);
  }));
  context.subscriptions.push({ dispose() { ++focusGeneration; } });
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
      if (!plan.draftsConsumed) {
        if (plan.draftScope) await vscode.commands.executeCommand('sweetiebot.codexDraft.adopt', plan);
        else {
          if (plan.draft != null) await vscode.commands.executeCommand('sweetiebot.codexDraft.write', plan.draft);
          if (plan.attachmentDrafts) await vscode.commands.executeCommand('sweetiebot.codexDraft.writeAttachments', handoffAttachments(plan));
        }
        await context.globalState.update(key, { ...plan, draftsConsumed: true });
      }
      if (plan.draftOnly) {
        if (plan.composerFocus) {
          await vscode.commands.executeCommand('chatgpt.openSidebar');
          await vscode.commands.executeCommand('sweetiebot.codexHandoff.restoreFocusWhenReady', { state: plan.composerFocus });
        }
        await context.globalState.update(key, undefined);
        return;
      }
      const result = await vscode.commands.executeCommand('sweetiebot.codex.resumeWorkspaceHandoff', { ...plan, journalWorkspace: workspace });
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

module.exports = { prepareCodexHandoff, registerCodexWorkspaceHandoff, retryCodexComposerFocus, keyFor, handoffAttachments };
