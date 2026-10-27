'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace_trust');
const { isWorkspaceDirectory, workspaceFileName } = require('./workspace_layout');

const execFileAsync = promisify(execFile);
const IDLE_MS = 60 * 60 * 1000;
const SCAN_MS = 10 * 60 * 1000;
const MANIFEST = '.sweetiebot-workspace.json';
const ACTIVATED = '.sweetiebot-activated';
const PROOFS = '.sweetiebot-merged';
const SESSION_PREFIX = '.sweetiebot-session-';

async function command(binary, args, cwd) {
  // macOS GUI-launched VS Code may omit Homebrew paths from its environment.
  // Resolve the same fixed tool locations as the existing Python PR pruner.
  for (const executable of [binary, '/opt/homebrew/bin/' + binary,
    '/usr/local/bin/' + binary, '/usr/bin/' + binary]) {
    try {
      const result = await execFileAsync(executable, args, {
        cwd, timeout: 60000, env: {
          ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1'
        }
      });
      return result.stdout.trim();
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      // Authentication, network, Git, or timeout failures never authorize deletion.
      return null;
    }
  }
  return null;
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function jsonFile(io, file) {
  try { return JSON.parse(await io.readFile(file, 'utf8')); }
  catch { return null; }
}

async function isPlainDirectory(io, folder) {
  try { return (await io.lstat(folder)).isDirectory(); }
  catch { return false; }
}

async function eligibleGroup(io, group, baseDirectory, now, alive) {
  if (!await isWorkspaceDirectory(io, group, baseDirectory) || !await isPlainDirectory(io, group)) return null;
  const manifest = await jsonFile(io, path.join(group, MANIFEST));
  const kind = manifest?.kind;
  if (manifest?.version !== 1 ||
      !['independent-clone', 'shared-main', 'topic-worktree', 'main-worktree'].includes(kind) ||
      !Array.isArray(manifest.repositories)) return null;
  const names = manifest.repositories;
  // Shared-main files have no checkout. Worktrees register one checkout;
  // independently cloned workspaces retain their legacy repository limits.
  if ((kind === 'independent-clone' && (!names.length || names.length > 20)) ||
      (kind === 'shared-main' && names.length !== 0) ||
      ((kind === 'topic-worktree' || kind === 'main-worktree') && names.length !== 1)) return null;
  if (new Set(names).size !== names.length || names.some(name =>
    typeof name !== 'string' || !name || name === '.' || name === '..' ||
    path.basename(name) !== name || name.startsWith('.'))) return null;

  // A workspace never activated by Sweetiebot may be open in Restricted Mode.
  // Do not consider it closed merely because no extension-host heartbeat exists.
  const activeStamp = path.join(group, ACTIVATED);
  let lastActive;
  try { lastActive = await io.lstat(activeStamp); }
  catch { return null; }
  if (!lastActive.isFile() || now - lastActive.mtimeMs < IDLE_MS) return null;

  const workspaceNames = new Set(['workspace.code-workspace', workspaceFileName(group)]);
  const allowed = new Set([MANIFEST, ACTIVATED, PROOFS, ...workspaceNames, ...names]);
  const entries = await io.readdir(group, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(SESSION_PREFIX) && entry.isFile()) {
      const session = await jsonFile(io, path.join(group, entry.name));
      // Corrupted session records are not proof that a window has closed.
      if (!session || alive(session.pid)) return null;
      continue;
    }
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) return null;
    if (names.includes(entry.name) && !entry.isDirectory()) return null;
    if (entry.name === PROOFS && !entry.isDirectory()) return null;
    if ((entry.name === MANIFEST || entry.name === ACTIVATED ||
         workspaceNames.has(entry.name)) && !entry.isFile()) return null;
  }
  for (const name of names) if (!await isPlainDirectory(io, path.join(group, name))) return null;
  // .code-workspace files are not part of Git status. Preserve user edits.
  // Support legacy workspace.code-workspace and new branch-color filenames.
  const workspaceFiles = entries.filter(entry => workspaceNames.has(entry.name));
  if (kind === 'shared-main' ||
      (kind === 'independent-clone' && names.length > 1)) {
    // Never discard edited or unreadable saved settings.
    if (workspaceFiles.length !== 1 || typeof manifest.workspaceFileContents !== 'string') return null;
    try {
      if (await io.readFile(path.join(group, workspaceFiles[0].name), 'utf8') !==
          manifest.workspaceFileContents) return null;
    } catch { return null; }
  } else if (workspaceFiles.length) return null;
  // Merge-proof directories only belong to legacy independent clones.
  if (kind !== 'independent-clone' && entries.some(entry => entry.name === PROOFS)) return null;
  // Only our own per-repository proof files may live in the proof directory.
  if (entries.some(entry => entry.name === PROOFS)) {
    const proofs = await io.readdir(path.join(group, PROOFS), { withFileTypes: true });
    if (proofs.some(entry => !entry.isFile() ||
        !names.some(name => entry.name === name + '.json'))) return null;
  }
  return names;
}

async function mergedEvidence(io, group, name, run) {
  const proofFile = path.join(group, PROOFS, name + '.json');
  let proofStat;
  try { proofStat = await io.lstat(proofFile); } catch { return null; }
  if (!proofStat.isFile()) return null;
  const proof = await jsonFile(io, proofFile);
  if (!proof || !Array.isArray(proof.merges) || !proof.merges.length || proof.merges.length > 100) return null;
  const verified = [];
  for (const merge of proof.merges) {
    if (!Number.isSafeInteger(merge.number) || merge.number < 1 ||
        typeof merge.repository !== 'string' || !/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(merge.repository) ||
        typeof merge.branch !== 'string' || merge.branch === 'main' ||
        !/^[0-9a-f]{40,64}$/.test(merge.oid) || merge.base !== 'main') return null;
    const cwd = path.join(group, name);
    const metadata = await run('gh', ['pr', 'view', String(merge.number),
      '--repo', merge.repository,
      '--json', 'state,mergedAt,baseRefName,headRefName,headRefOid,isCrossRepository,commits'], cwd);
    if (metadata === null) return null;
    let pr;
    try { pr = JSON.parse(metadata); } catch { return null; }
    const commit = pr?.headRefOid ?? pr?.commits?.at(-1)?.oid;
    if (pr.state !== 'MERGED' || !pr.mergedAt || pr.isCrossRepository ||
        pr.baseRefName !== 'main' || pr.headRefName !== merge.branch ||
        commit !== merge.oid) return null;
    const open = await run('gh', ['pr', 'list', '--repo', merge.repository,
      '--head', merge.branch, '--state', 'open', '--limit', '1', '--json', 'number'], cwd);
    if (open === null) return null;
    try { if (JSON.parse(open).length !== 0) return null; } catch { return null; }
    verified.push(merge);
  }
  return verified;
}

async function cleanClone(group, name, io, run) {
  const cwd = path.join(group, name);
  const proofs = await mergedEvidence(io, group, name, run);
  if (!proofs) return false;
  // Reconcile the remote before checking for unpushed commits.
  if (await run('git', ['fetch', '--prune', '--no-tags', 'origin'], cwd) === null) return false;
  const origin = await run('git', ['remote', 'get-url', 'origin'], cwd);
  if (!origin) return false;
  const repoMatch = origin.match(/(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!repoMatch || proofs.some(proof =>
    proof.repository !== repoMatch.slice(1).join('/'))) return false;
  if (await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd) !== 'main') return false;
  if (await run('git', ['for-each-ref', '--format=%(refname:short)', 'rextension/heads'], cwd) !== 'main') return false;
  if (await run('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], cwd) !== '') return false;
  if (await run('git', ['rev-parse', '--verify', '--quiet', 'rextension/stash'], cwd) !== null) return false;
  if (await run('git', ['merge-base', '--is-ancestor', 'HEAD', 'rextension/remotes/origin/main'], cwd) === null) return false;
  if (await run('git', ['rev-list', '--count', '--branches', '--not', '--remotes'], cwd) !== '0') return false;

  // A deleted branch may leave merged commits in the HEAD reflog. Every such
  // commit must be reachable from upstream main or an independently verified
  // merged PR head. Unknown orphaned commits always protect this clone.
  const history = await run('git', ['reflog', 'show', '--all', '--format=%H'], cwd);
  if (history === null) return false;
  const commits = [...new Set(history.split('\n').filter(Boolean))];
  if (commits.length > 500) return false;
  for (const sha of commits) {
    if (await run('git', ['merge-base', '--is-ancestor', sha, 'rextension/remotes/origin/main'], cwd) !== null) continue;
    let recognized = false;
    for (const proof of proofs) {
      if (await run('git', ['merge-base', '--is-ancestor', sha, proof.oid], cwd) !== null) {
        recognized = true; break;
      }
    }
    if (!recognized) return false;
  }
  return true;
}

// A linked worktree shares its Git objects with the original repository. Never
// recursively remove the checkout: Git must detach it from the shared database.
async function cleanWorktree(group, name, kind, io, run, dryRun) {
  const cwd = path.join(group, name);
  if (await run('git', ['rev-parse', '--show-toplevel'], cwd) !== cwd) return false;
  const common = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common || path.basename(common) !== '.git') return false;
  const original = path.dirname(common);
  if (path.resolve(original) === path.resolve(cwd) ||
      !await isPlainDirectory(io, original)) return false;
  const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (!branch || (kind === 'main-worktree' ? branch !== 'main' : branch === 'main')) return false;
  const recorded = await jsonFile(io, path.join(group, MANIFEST));
  if (recorded.branch && recorded.branch !== branch) return false;
  const worktrees = await run('git', ['worktree', 'list', '--porcelain'], original);
  if (!worktrees || !worktrees.split('\n\n').some(block => {
    const lines = block.split('\n');
    return lines.includes('worktree ' + cwd) && lines.includes('branch rextension/heads/' + branch);
  })) return false;
  if (await run('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], cwd) !== '') return false;
  // Stashes live in the common Git database. Do not erase associated worktree
  // state while there is anything left to recover.
  if (await run('git', ['rev-parse', '--verify', '--quiet', 'rextension/stash'], cwd) !== null) return false;
  const head = await run('git', ['rev-parse', 'HEAD'], cwd);
  if (!head || await run('git', ['rev-parse', 'rextension/heads/' + branch], original) !== head) return false;
  const origin = await run('git', ['remote', 'get-url', 'origin'], original);
  const match = origin?.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!match || await run('git', ['fetch', '--prune', '--no-tags', 'origin'], original) === null) return false;

  if (kind === 'main-worktree') {
    // In particular, do not discard local main commits that were never pushed.
    if (await run('git', ['merge-base', '--is-ancestor', 'HEAD',
      'rextension/remotes/origin/main'], cwd) === null) return false;
  } else {
    const repository = match[1] + '/' + match[2];
    const open = await run('gh', ['pr', 'list', '--repo', repository, '--head',
      branch, '--state', 'open', '--limit', '1', '--json', 'number'], cwd);
    if (open === null) return false;
    try { if (JSON.parse(open).length) return false; } catch { return false; }
    const merged = await run('gh', ['pr', 'list', '--repo', repository, '--head',
      branch, '--state', 'merged', '--limit', '100', '--json', 'number'], cwd);
    if (merged === null) return false;
    let candidates;
    try { candidates = JSON.parse(merged); } catch { return false; }
    if (!Array.isArray(candidates) || candidates.length > 100) return false;
    let verified = false;
    for (const { number } of candidates) {
      if (!Number.isSafeInteger(number) || number < 1) return false;
      const value = await run('gh', ['pr', 'view', String(number), '--repo',
        repository, '--json', 'state,mergedAt,baseRefName,headRefName,headRefOid,isCrossRepository,commits'], cwd);
      if (value === null) return false;
      let pr;
      try { pr = JSON.parse(value); } catch { return false; }
      if (pr.state === 'MERGED' && pr.mergedAt && !pr.isCrossRepository &&
          pr.baseRefName === 'main' && pr.headRefName === branch &&
          (pr.headRefOid ?? pr.commits?.at(-1)?.oid) === head) {
        verified = true;
        break;
      }
    }
    if (!verified) return false;
  }

  // Repeat checks immediately before invoking Git's non-forced worktree
  // removal. A concurrent writer makes Git refuse the removal as well.
  if (!await eligibleGroup(io, group, path.dirname(path.dirname(group)), Date.now(), isAlive)) return false;
  if (await run('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], cwd) !== '' ||
      await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd) !== branch ||
      await run('git', ['rev-parse', 'HEAD'], cwd) !== head) return false;
  if (dryRun) return true;
  if (await run('git', ['worktree', 'remove', '--', cwd], original) === null) return false;
  if (kind === 'topic-worktree') {
    // Squash merges require -D, since the original PR commits are not
    // ancestors of main. The branch tip was verified against the merged PR.
    if (await run('git', ['rev-parse', 'rextension/heads/' + branch], original) === head) {
      await run('git', ['branch', '-D', '--', branch], original);
    }
  }
  // Git removed the checkout; only Sweetiebot's small metadata remains.
  await io.rm(group, { recursive: true, force: false });
  return true;
}

// A saved workspace (including an edited one) may still refer to the checkout.
// Remove that workspace first, or preserve the worktree for reopening.
async function hasSavedWorkspaceReference(io, groups, worktree) {
  for (const group of groups) {
    const manifest = await jsonFile(io, path.join(group, MANIFEST));
    if (manifest?.kind !== 'shared-main') continue;
    let saved;
    try {
      const knownNames = new Set(['workspace.code-workspace', workspaceFileName(group)]);
      const files = (await io.readdir(group, { withFileTypes: true }))
        .filter(entry => entry.name.endsWith('.code-workspace'));
      // Missing, ambiguous, unfamiliar, or symlinked saved windows must
      // protect their linked checkout until a human can inspect them.
      if (files.length !== 1 || !knownNames.has(files[0].name) ||
          !files[0].isFile() || files[0].isSymbolicLink()) return true;
      saved = JSON.parse(await io.readFile(path.join(group, files[0].name), 'utf8'));
    } catch { return true; } // Unknown references are not proof of safety.
    if (!Array.isArray(saved.folders)) return true;
    for (const folder of saved.folders) {
      if (typeof folder.path !== 'string' || !path.isAbsolute(folder.path)) return true;
      const relative = path.relative(worktree, folder.path);
      if (relative === '' || (relative !== '..' &&
          !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) return true;
    }
  }
  return false;
}

async function pruneManagedWorkspaces({
  baseDirectory = independentWorkspaceParent(), io = fs, run = command,
  now = Date.now(), alive = isAlive, dryRun = false, log = () => {}
} = {}) {
  if (!await isPlainDirectory(io, baseDirectory)) return [];
  // Multiple VS Code windows run this extension. A process-wide exclusive
  // directory lock prevents overlapping deletion scans across windows.
  const lock = path.join(baseDirectory, '.sweetiebot-workspace-prune.lock');
  let lease;
  try { lease = await io.open(lock, 'wx', 0o600); }
  catch { return []; }
  const pruned = [];
  try {
    const entries = await io.readdir(baseDirectory, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const parent = path.join(baseDirectory, entry.name);
      candidates.push(parent);
      try {
        // Only inspect one extra level; never descend into a legacy checkout.
        if (await jsonFile(io, path.join(parent, MANIFEST))) continue;
        for (const child of await io.readdir(parent, { withFileTypes: true })) {
          if (child.isDirectory() && !child.isSymbolicLink()) candidates.push(path.join(parent, child.name));
        }
      } catch (error) {
        log('Preserved ' + parent + ': ' + error.message);
      }
    }
    // Metadata first; a linked checkout may only be removed once every
    // saved workspace pointing at it is gone.
    const ranks = { 'shared-main': 0, 'topic-worktree': 1,
      'main-worktree': 2, 'independent-clone': 3 };
    const kinds = new Map();
    for (const group of candidates) {
      const manifest = await jsonFile(io, path.join(group, MANIFEST));
      kinds.set(group, manifest?.kind);
    }
    candidates.sort((a, b) => (ranks[kinds.get(a)] ?? 4) - (ranks[kinds.get(b)] ?? 4));
    for (const group of candidates) {
      try {
        const names = await eligibleGroup(io, group, baseDirectory, now, alive);
        if (!names) continue;
        const kind = kinds.get(group);
        let safe = true;
        if (kind === 'independent-clone') {
          for (const name of names) if (!await cleanClone(group, name, io, run)) {
            safe = false; break;
          }
          if (!safe || !await eligibleGroup(io, group, baseDirectory, Date.now(), alive)) continue;
          // Recheck the clones immediately before the destructive operation.
          for (const name of names) {
            const dirty = await run('git',
              ['status', '--porcelain', '--ignored', '--untracked-files=all'], path.join(group, name));
            if (dirty !== '') { safe = false; break; }
          }
          if (!safe) continue;
          if (!dryRun) await io.rm(group, { recursive: true, force: false });
        } else if (kind === 'shared-main') {
          if (!await eligibleGroup(io, group, baseDirectory, Date.now(), alive)) continue;
          if (!dryRun) await io.rm(group, { recursive: true, force: false });
        } else if (kind === 'topic-worktree' || kind === 'main-worktree') {
          if (await hasSavedWorkspaceReference(io, candidates.filter(candidate =>
            candidate !== group && (!pruned.includes(candidate) || dryRun)),
          path.join(group, names[0]))) continue;
          if (!await cleanWorktree(group, names[0], kind, io, run, dryRun)) continue;
        } else continue;
        pruned.push(group);
        log((dryRun ? 'Would prune ' : 'Pruned ') + group);
      } catch (error) {
        log('Preserved ' + group + ': ' + error.message);
      }
    }
    return pruned;
  } finally {
    await lease.close();
    await io.rm(lock, { force: true });
  }
}

function registerWorkspaceCleanup(vscode, context) {
  const output = vscode.window.createOutputChannel('Sweetiebot Workspace Cleanup');
  context.subscriptions.push(output);
  let running = false;
  let disposed = false;
  const scan = async () => {
    if (disposed || running || !vscode.workspace.getConfiguration('scmToolkit')
      .get('automaticWorkspaceCleanup', true)) return;
    running = true;
    try { await pruneManagedWorkspaces({ log: message => output.appendLine(message) }); }
    catch (error) { output.appendLine('Workspace cleanup failed: ' + error.message); }
    finally { running = false; }
  };
  const timer = setInterval(() => void scan(), SCAN_MS);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); } });
  setImmediate(() => void scan());
}

module.exports = { pruneManagedWorkspaces, eligibleGroup, mergedEvidence, cleanClone,
  cleanWorktree, hasSavedWorkspaceReference, registerWorkspaceCleanup,
  MANIFEST, ACTIVATED, PROOFS, SESSION_PREFIX };
