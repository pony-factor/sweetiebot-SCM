'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace_trust');

const execFileAsync = promisify(execFile);
const IDLE_MS = 60 * 60 * 1000;
const SCAN_MS = 10 * 60 * 1000;
const MANIFEST = '.sweetiebot-workspace.json';
const ACTIVATED = '.sweetiebot-activated';
const PROOFS = '.sweetiebot-merged';
const SESSION_PREFIX = '.sweetiebot-session-';

async function command(binary, args, cwd) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd, timeout: 60000, env: {
        ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1'
      }
    });
    return result.stdout.trim();
  } catch {
    return null; // Authentication, network, Git, or timeout failures never authorize deletion.
  }
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
  if (path.dirname(group) !== baseDirectory || !await isPlainDirectory(io, group)) return null;
  const manifest = await jsonFile(io, path.join(group, MANIFEST));
  if (manifest?.version !== 1 || manifest.kind !== 'independent-clone' ||
      !Array.isArray(manifest.repositories) || !manifest.repositories.length ||
      manifest.repositories.length > 20) return null;
  const names = manifest.repositories;
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

  const allowed = new Set([MANIFEST, ACTIVATED, PROOFS, 'workspace.code-workspace', ...names]);
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
         entry.name === 'workspace.code-workspace') && !entry.isFile()) return null;
  }
  for (const name of names) if (!await isPlainDirectory(io, path.join(group, name))) return null;
  // .code-workspace files are not part of Git status. Preserve user edits.
  if (names.length > 1) {
    if (typeof manifest.workspaceFileContents !== 'string' ||
        await io.readFile(path.join(group, 'workspace.code-workspace'), 'utf8')
          !== manifest.workspaceFileContents) return null;
  } else if (entries.some(entry => entry.name === 'workspace.code-workspace')) return null;
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
  if (await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd) !== 'main') return false;
  if (await run('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], cwd) !== '') return false;
  if (await run('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], cwd) !== null) return false;
  if (await run('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], cwd) === null) return false;
  if (await run('git', ['rev-list', '--count', '--branches', '--not', '--remotes'], cwd) !== '0') return false;

  // A deleted branch may leave merged commits in the HEAD reflog. Every such
  // commit must be reachable from upstream main or an independently verified
  // merged PR head. Unknown orphaned commits always protect this clone.
  const history = await run('git', ['reflog', 'show', '--all', '--format=%H'], cwd);
  if (history === null) return false;
  const commits = [...new Set(history.split('\n').filter(Boolean))];
  if (commits.length > 500) return false;
  for (const sha of commits) {
    if (await run('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'], cwd) !== null) continue;
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
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const group = path.join(baseDirectory, entry.name);
      try {
        const names = await eligibleGroup(io, group, baseDirectory, now, alive);
        if (!names) continue;
        let safe = true;
        for (const name of names) if (!await cleanClone(group, name, io, run)) {
          safe = false; break;
        }
        if (!safe || !await eligibleGroup(io, group, baseDirectory, Date.now(), alive)) continue;
        // Recheck the worktrees after remote access and immediately before
        // the destructive operation; abort if a user has begun writing.
        for (const name of names) {
          const dirty = await run('git',
            ['status', '--porcelain', '--ignored', '--untracked-files=all'], path.join(group, name));
          if (dirty !== '') { safe = false; break; }
        }
        if (!safe) continue;
        if (!dryRun) await io.rm(group, { recursive: true, force: false });
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
  registerWorkspaceCleanup, MANIFEST, ACTIVATED, PROOFS, SESSION_PREFIX };
