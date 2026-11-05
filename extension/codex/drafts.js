'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

// Managed windows have unique workspace files, even when they share main's
// checkout. Keep that identity stable across reloads, and partition it by HEAD.
function codexDraftStorageKey(vscode, { branches = [], storageUri } = {}) {
  const roots = (vscode.workspace.workspaceFolders || [])
    .map(folder => folder.uri?.toString?.(true)).filter(Boolean).sort();
  if (!roots.length) return undefined;
  const workspace = vscode.workspace.workspaceFile;
  const window = workspace?.toString?.(true) || workspace?.fsPath || storageUri?.toString?.(true) || roots;
  const hash = createHash('sha256').update(JSON.stringify({ window, roots, branches })).digest('hex');
  return `sweetiebot.codexDraft.v2.${hash}`;
}

async function branchScopes(vscode) {
  return Promise.all((vscode.workspace.workspaceFolders || []).map(async folder => {
    const root = folder.uri?.fsPath;
    if (!root || folder.uri.scheme && folder.uri.scheme !== 'file') return [folder.uri?.toString?.(true), null];
    const git = async args => (await exec('git', args, { cwd: root, timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
    try { return [folder.uri.toString(true), await git(['symbolic-ref', '--quiet', 'HEAD'])]; }
    catch (error) {
      if (error.code === 1) return [folder.uri.toString(true), await git(['rev-parse', '--verify', 'HEAD'])];
      if (error.code === 'ENOENT' || error.code === 128) return [folder.uri.toString(true), null];
      throw Error('Could not identify the branch for this Codex draft.');
    }
  })).then(scopes => scopes.sort(([a], [b]) => a.localeCompare(b)));
}

function registerCodexDraftCommands(vscode, context, { resolveBranches = branchScopes } = {}) {
  let writing = Promise.resolve();
  let storageError;
  const keyForScope = async () => codexDraftStorageKey(vscode, {
    branches: await resolveBranches(vscode), storageUri: context.storageUri
  });
  const record = key => context.globalState.get(key) || {};
  const persist = async (key, value) => {
    try { await context.globalState.update(key, value); storageError = undefined; }
    catch (error) { storageError = error; throw error; }
  };
  const pending = () => {
    const workspace = vscode.workspace.workspaceFile?.fsPath;
    const plan = workspace && context.globalState.get(require('./workspace-handoff').keyFor(workspace));
    const roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    return plan && !plan.draftsConsumed && roots.includes(plan.destination) ? plan : null;
  };
  const read = async () => {
    await writing.catch(() => {});
    if (storageError) throw storageError;
    const scope = await keyForScope();
    if (!scope) return { enabled: false };
    const plan = pending();
    if (plan?.draftScope) {
      try { await vscode.commands.executeCommand('sweetiebot.codexDraft.adopt', plan); }
      catch (error) { if (storageError) throw error; } // Resume reports a conflict; show this window's own draft.
    }
    const saved = record(scope);
    // Never seed a fresh window from the old checkout-wide cache. Keep those
    // legacy entries intact, but only an explicit handoff may move a draft.
    return { enabled: true, scope,
      draft: plan && !plan.draftScope ? plan.draft ?? null : saved.draft ?? null,
      drafts: plan?.attachmentDrafts && !plan.draftScope ? require('./workspace-handoff').handoffAttachments(plan) : saved.attachments || {} };
  };
  const enqueue = operation => {
    writing = writing.catch(() => {}).then(operation);
    return writing;
  };
  const register = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  register('sweetiebot.codexDraft.read', async () => {
    const result = await read();
    return result.enabled ? { enabled: true, scope: result.scope, draft: result.draft } : result;
  });
  register('sweetiebot.codexDraft.readAttachments', async () => {
    const result = await read();
    return result.enabled ? { enabled: true, scope: result.scope, drafts: result.drafts } : result;
  });
  const write = (field, value, options = {}) => {
    // Start resolving the receiving scope when the IPC message arrives, rather
    // than after an earlier disk write finishes or a branch switch completes.
    const scopePromise = keyForScope();
    return enqueue(async () => {
      const scope = await scopePromise;
      if (!scope || options.scope && options.scope !== scope) return false;
      if (await keyForScope() !== scope) return false;
      const saved = record(scope);
      if (Object.prototype.hasOwnProperty.call(options, 'expectedValue') && options.expectedValue !== undefined
          && !isDeepStrictEqual(saved[field], options.expectedValue)) return false;
      await persist(scope, { ...saved, [field]: value });
      return true;
    });
  };
  register('sweetiebot.codexDraft.write', (draft, options) => {
    if (draft !== null && (typeof draft !== 'string' && (!draft || typeof draft !== 'object' || Array.isArray(draft))
        || JSON.stringify(draft).length > 2000000)) throw Error('Invalid Codex composer draft.');
    return write('draft', draft === null || draft === '' ? undefined : draft, options);
  });
  register('sweetiebot.codexDraft.writeAttachments', (drafts, options) => {
    if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts) || JSON.stringify(drafts).length > 32 * 1024 * 1024) {
      storageError = Error('Invalid or oversized Codex attachment draft. Keep this window open; the checkout handoff is paused.');
      return Promise.reject(storageError);
    }
    return write('attachments', drafts, options);
  });
  register('sweetiebot.codexDraft.adopt', plan => enqueue(async () => {
    const scope = await keyForScope();
    if (!scope) throw Error('A workspace is required to transfer a Codex draft.');
    const saved = record(scope);
    const id = plan.draftTransferId;
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^sweetiebot\.codexDraft\.v2\.[a-f0-9]{64}$/.test(plan.draftScope || '')) {
      throw Error('The Codex draft handoff has no verified source scope.');
    }
    const incoming = { draft: plan.draft ?? undefined,
      attachments: plan.attachmentDrafts ? require('./workspace-handoff').handoffAttachments(plan) : {} };
    const adopted = saved.transfers?.includes(id);
    const transferKey = 'sweetiebot.codexDraft.transfer.' + id;
    const owner = context.globalState.get(transferKey);
    if (owner && owner !== scope) throw Error('This Codex draft has already moved to another window and branch.');
    if (!adopted) {
      if ((saved.draft != null && !isDeepStrictEqual(saved.draft, incoming.draft))
          || (Object.keys(saved.attachments || {}).length && !isDeepStrictEqual(saved.attachments, incoming.attachments))) {
        throw Error('This window and branch already have an unsent draft. Its contents were preserved.');
      }
      await persist(transferKey, scope);
      await persist(scope, { ...saved, ...incoming, transfers: [...(saved.transfers || []), id] });
    }
    if (scope !== plan.draftScope) {
      const source = record(plan.draftScope);
      // Retire the captured copy only. A newer source draft belongs to its user.
      if (isDeepStrictEqual(source.draft ?? null, plan.draft ?? null)
          && isDeepStrictEqual(source.attachments || {}, plan.attachmentDrafts || {})) {
        await persist(plan.draftScope, { transfers: source.transfers || [] });
      }
    }
    return true;
  }));

  // A plain Git checkout can change branches without restarting the host.
  // Ask each live composer to hydrate its new scope instead of carrying text.
  const extension = vscode.extensions?.getExtension('vscode.git');
  if (extension) Promise.resolve(extension.activate()).then(exports => {
    const api = exports.getAPI(1);
    const watch = repository => {
      let previous = repository.state.HEAD?.name || repository.state.HEAD?.commit;
      context.subscriptions.push(repository.state.onDidChange(() => {
        const current = repository.state.HEAD?.name || repository.state.HEAD?.commit;
        if (current === previous) return;
        previous = current;
        void vscode.commands.executeCommand('sweetiebot.codexDraft.refresh').catch(() => {});
      }));
    };
    for (const repository of api.repositories) watch(repository);
    context.subscriptions.push(api.onDidOpenRepository(watch));
  }).catch(() => {});
}

module.exports = { codexDraftStorageKey, registerCodexDraftCommands, branchScopes };
