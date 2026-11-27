'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const promptV1 = 'composer-prompt-drafts-v1';
const promptV2 = 'composer-prompt-drafts-v2';
const attachmentsAtom = 'sweetiebot-composer-attachments-v1';
const composerAtoms = new Set([
  promptV1, promptV2, 'composer-retained-documents-v1', 'draft-thread-identities-v1', attachmentsAtom
]);
const home = 'new-conversation';
const isRecord = value => value != null && typeof value === 'object' && !Array.isArray(value);

function draftAtoms(saved) {
  const atoms = { ...saved.composerAtoms, [attachmentsAtom]: saved.attachments || {} };
  if (saved.draft != null && atoms[promptV1] == null && atoms[promptV2] == null) {
    atoms[promptV1] = { [home]: saved.draft };
  }
  return atoms;
}

function handoffDraftAtoms(atoms, threadId) {
  const keys = threadId ? [threadId, 'local:' + threadId] : [home, 'panel-new-conversation'];
  return Object.fromEntries(Object.entries(atoms).flatMap(([atom, drafts]) => {
    const entries = Object.entries(drafts || {}).filter(([key]) => keys.includes(key));
    return entries.length ? [[atom, Object.fromEntries(entries)]] : [];
  }));
}

function applyDraftEntries(atoms, key, update) {
  const next = { ...(atoms[key] ?? atoms[update.legacyStorageKey]) };
  for (const [id, entry] of Object.entries(update.entries)) {
    if (entry?.expectedValue !== undefined && !isDeepStrictEqual(next[id], entry.expectedValue)) continue;
    if (entry == null || Object.hasOwn(entry, 'delete')) {
      delete next[id];
      continue;
    }
    if (entry.createOnly && Object.hasOwn(next, id)) continue;
    const match = entry.deleteIfRecordEntryMatches;
    if (match && Object.hasOwn(atoms[match.recordKey] || {}, match.entryKey) &&
        isDeepStrictEqual(atoms[match.recordKey][match.entryKey], match.expectedValue)) {
      delete next[id];
      continue;
    }
    if (entry.updateOnly && !Object.hasOwn(next, id)) continue;
    if (!entry.updateOnly) delete next[id];
    Object.defineProperty(next, id, { value: entry.value, enumerable: true, writable: true, configurable: true });
  }
  return next;
}

// Managed windows have unique workspace files, even when they share main's
// checkout. Keep that identity stable across reloads, and partition it by HEAD.
function codexDraftStorageKey(vscode, { branches = [], storageUri } = {}) {
  const roots = (vscode.workspace.workspaceFolders || [])
    .map(folder => folder.uri?.toString?.(true)).filter(Boolean).sort();
  const workspace = vscode.workspace.workspaceFile;
  const window = workspace?.toString?.(true) || workspace?.fsPath || storageUri?.toString?.(true) || (roots.length ? roots : undefined);
  if (!window) return undefined;
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
  // VS Code's global memento writes the whole extension state. Separate files
  // let two extension hosts persist drafts for different scopes concurrently.
  const storageRoot = context.globalStorageUri?.fsPath;
  const directory = storageRoot && path.join(storageRoot, 'codex-drafts');
  const stored = async key => {
    if (directory) {
      try { return JSON.parse(await fs.readFile(path.join(directory, key + '.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return context.globalState.get(key);
  };
  const record = async key => (await stored(key)) || {};
  const persist = async (key, value) => {
    try {
      if (!directory) await context.globalState.update(key, value);
      else {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, randomUUID() + '.tmp');
        try {
          await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, path.join(directory, key + '.json'));
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      storageError = undefined;
    } catch (error) { storageError = error; throw error; }
  };
  const storeAtoms = (saved, atoms) => {
    const { [attachmentsAtom]: attachments, ...composerAtoms } = atoms;
    return { ...saved, composerAtoms, attachments, draft: (atoms[promptV2] ?? atoms[promptV1])?.[home] };
  };
  const withHome = (saved, draft) => {
    const atoms = draftAtoms(saved);
    for (const key of [promptV1, promptV2]) {
      if (key === promptV2 && !atoms[key]) continue;
      const drafts = { ...atoms[key] };
      if (draft !== undefined) drafts[home] = draft;
      else delete drafts[home];
      atoms[key] = drafts;
    }
    return storeAtoms(saved, atoms);
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
    const saved = await record(scope);
    const legacy = plan && !plan.draftScope;
    const atoms = draftAtoms(legacy
      ? { ...withHome(saved, plan.draft ?? undefined),
        attachments: plan.attachmentDrafts ? require('./workspace-handoff').handoffAttachments(plan) : saved.attachments }
      : saved);
    // Never seed a fresh window from the old checkout-wide cache. Keep those
    // legacy entries intact, but only an explicit handoff may move a draft.
    return { enabled: true, scope, generation: saved.generation || 0,
      atoms, draft: (atoms[promptV2] ?? atoms[promptV1])?.[home] ?? null,
      drafts: atoms[attachmentsAtom] };
  };
  const enqueue = operation => {
    writing = writing.catch(() => {}).then(operation);
    return writing;
  };
  const register = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  register('sweetiebot.codexDraft.read', async () => {
    const result = await read();
    return result.enabled ? { enabled: true, scope: result.scope, generation: result.generation, draft: result.draft } : result;
  });
  register('sweetiebot.codexDraft.readAttachments', async () => {
    const result = await read();
    return result.enabled ? { enabled: true, scope: result.scope, generation: result.generation, drafts: result.drafts } : result;
  });
  register('sweetiebot.codexDraft.readAtoms', read);
  const update = (options = {}, apply) => {
    // Start resolving the receiving scope when the IPC message arrives, rather
    // than after an earlier disk write finishes or a branch switch completes.
    const scopePromise = keyForScope().then(scope => ({ scope }), error => ({ error }));
    return enqueue(async () => {
      const { scope, error } = await scopePromise;
      if (error) throw error;
      if (!scope || options.scope && options.scope !== scope) return false;
      if (await keyForScope() !== scope) return false;
      const saved = await record(scope);
      if (options.generation !== undefined && options.generation !== (saved.generation || 0)) return false;
      return apply(scope, saved);
    });
  };
  register('sweetiebot.codexDraft.write', (draft, options) => {
    if (draft !== null && (typeof draft !== 'string' && (!draft || typeof draft !== 'object' || Array.isArray(draft))
        || JSON.stringify(draft).length > 2000000)) throw Error('Invalid Codex composer draft.');
    return update(options || {}, async (scope, saved) => {
      if (options?.expectedValue !== undefined && !isDeepStrictEqual(saved.draft, options.expectedValue)) return false;
      await persist(scope, withHome(saved, draft === null || draft === '' ? undefined : draft));
      return true;
    });
  });
  register('sweetiebot.codexDraft.writeAttachments', (drafts, options) => {
    if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts) || JSON.stringify(drafts).length > 32 * 1024 * 1024) {
      storageError = Error('Invalid or oversized Codex attachment draft. Keep this window open; the checkout handoff is paused.');
      return Promise.reject(storageError);
    }
    return update(options || {}, async (scope, saved) => {
      await persist(scope, { ...saved, attachments: drafts });
      return true;
    });
  });
  register('sweetiebot.codexDraft.writeAtom', (message, options) => update(options, async (scope, saved) => {
    const { key, recordUpdate, deleted } = message;
    if (!composerAtoms.has(key)) return false;
    const atoms = draftAtoms(saved);
    let value = message.value;
    if (recordUpdate) {
      if (!isRecord(recordUpdate.entries)) return false;
      value = applyDraftEntries(atoms, key, recordUpdate);
    } else if (deleted) {
      value = undefined;
    } else if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return false; }
    }
    if (value !== undefined && (!isRecord(value) || JSON.stringify(value).length > 32 * 1024 * 1024)) {
      storageError = Error('Invalid or oversized Codex composer draft.');
      throw storageError;
    }
    if (key === promptV2) delete atoms[promptV1]; // v2 consumes the scoped v1 fallback.
    if (value === undefined) delete atoms[key];
    else atoms[key] = value;
    if (!isDeepStrictEqual(atoms, draftAtoms(saved))) await persist(scope, storeAtoms(saved, atoms));
    return { scope, generation: saved.generation || 0, atoms };
  }));
  register('sweetiebot.codexDraft.adopt', plan => enqueue(async () => {
    const scope = await keyForScope();
    if (!scope) throw Error('A workspace is required to transfer a Codex draft.');
    const saved = await record(scope);
    const id = plan.draftTransferId;
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^sweetiebot\.codexDraft\.v2\.[a-f0-9]{64}$/.test(plan.draftScope || '')) {
      throw Error('The Codex draft handoff has no verified source scope.');
    }
    const incoming = { draft: plan.draft ?? undefined,
      attachments: plan.attachmentDrafts ? require('./workspace-handoff').handoffAttachments(plan) : {} };
    const captured = plan.composerDrafts;
    const moved = captured && { ...captured,
      ...(incoming.attachments && captured[attachmentsAtom] ? { [attachmentsAtom]: incoming.attachments } : {}) };
    const adopted = saved.transfers?.includes(id);
    const transferKey = 'sweetiebot.codexDraft.transfer.' + id;
    const owner = await stored(transferKey);
    if (owner && owner !== scope) throw Error('This Codex draft has already moved to another window and branch.');
    if (!adopted && moved) {
      const destination = draftAtoms(saved);
      for (const [atom, drafts] of Object.entries(moved)) {
        if (!composerAtoms.has(atom) || !isRecord(drafts)) throw Error('Invalid Codex composer handoff.');
        const existing = destination[atom] ?? (atom === promptV1 ? destination[promptV2]
          : atom === promptV2 ? destination[promptV1] : undefined);
        for (const [key, value] of Object.entries(drafts)) {
          if (Object.hasOwn(existing || {}, key) && !isDeepStrictEqual(existing[key], value)) {
            throw Error('This window and branch already have an unsent draft for this chat. Its contents were preserved.');
          }
        }
        const target = atom === promptV1 && destination[promptV2] ? promptV2 : atom;
        destination[target] = { ...existing, ...drafts };
        if (target === promptV2) delete destination[promptV1];
      }
      await persist(transferKey, scope);
      await persist(scope, storeAtoms({ ...saved, transfers: [...(saved.transfers || []), id] }, destination));
    } else if (!adopted) {
      if ((saved.draft != null && !isDeepStrictEqual(saved.draft, incoming.draft))
          || (Object.keys(saved.attachments || {}).length && !isDeepStrictEqual(saved.attachments, incoming.attachments))) {
        throw Error('This window and branch already have an unsent draft. Its contents were preserved.');
      }
      await persist(transferKey, scope);
      await persist(scope, { ...withHome(saved, incoming.draft), attachments: incoming.attachments, transfers: [...(saved.transfers || []), id] });
    }
    if (scope !== plan.draftScope) {
      const source = await record(plan.draftScope);
      // Retire the captured entries only. Other chats and newer edits stay put.
      if ((source.generation || 0) !== (plan.draftGeneration || 0)) return true;
      if (captured) {
        const atoms = draftAtoms(source);
        for (const [atom, drafts] of Object.entries(captured)) {
          if (!atoms[atom]) continue;
          const remaining = { ...atoms[atom] };
          for (const [key, value] of Object.entries(drafts)) {
            if (isDeepStrictEqual(remaining[key], value)) delete remaining[key];
          }
          atoms[atom] = remaining;
        }
        if (!isDeepStrictEqual(atoms, draftAtoms(source))) {
          await persist(plan.draftScope, storeAtoms({ ...source, generation: (source.generation || 0) + 1 }, atoms));
        }
      } else if (isDeepStrictEqual(source.draft ?? null, plan.draft ?? null)
          && isDeepStrictEqual(source.attachments || {}, plan.attachmentDrafts || {})) {
        await persist(plan.draftScope, { ...withHome(source, undefined), attachments: {}, generation: (source.generation || 0) + 1 });
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

module.exports = { codexDraftStorageKey, registerCodexDraftCommands, branchScopes, handoffDraftAtoms, attachmentsAtom };
