'use strict';

// Prepared worktrees share the original object database. A fixed slot per
// common Git directory bounds disk use across extension hosts. Only the
// owner of an atomic ready -> busy rename may refresh, move or remove it.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentWorkspaceParent } = require('./workspace-trust');
const exec = promisify(execFile);
const READY = '.sweetiebot-prepared.json';
const BUSY = '.sweetiebot-prepared-busy.json';
const SLOT = /^\.prepared-[a-f0-9]{24}-[1-6]$/;
const IDLE_MS = 30 * 60 * 1000;
const SCAN_MS = 30 * 1000;
const SHA = /^[a-f0-9]{40,64}$/;
let output;

function timing(stage, started) {
  output?.appendLine(stage + ': ' + Math.round(performance.now() - started) + ' ms');
}
async function git(args) {
  return (await exec('git', args, { timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
function config(vscode) {
  const settings = vscode.workspace?.getConfiguration?.('sweetiebot');
  const bounded = (value, min, max, fallback) => Number.isInteger(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    enabled: settings?.get('prewarmBranchWorktrees', true) !== false,
    count: bounded(settings?.get('preparedWorktreesPerRepository', 3), 1, 6, 3),
    replenish: settings?.get('replenishPreparedWorktrees', true) !== false,
    idleMs: bounded(settings?.get('preparedWorktreeIdleMinutes', 30), 5, 1440, 30) * 60000
  };
}
async function plain(directory) {
  return (await fs.lstat(directory).catch(() => null))?.isDirectory() === true;
}
async function identity(root, run) {
  const common = await fs.realpath(await run(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
  const original = path.basename(common) === '.git' ? path.dirname(common) : null;
  if (!original || !await plain(original)) return null;
  const name = path.basename(original);
  const hash = createHash('sha256').update(common).digest('hex').slice(0, 24);
  return { common, original, name, hash };
}
function slots(base, repo, count) {
  return Array.from({ length: count }, (_, i) =>
    path.join(base, repo.name.replace(/[^a-zA-Z0-9._-]/g, '-'), '.prepared-' + repo.hash + '-' + (i + 1)));
}
async function readClaim(directory) {
  if (!await plain(directory) || !SLOT.test(path.basename(directory))) return null;
  const ready = path.join(directory, READY), busy = path.join(directory, BUSY);
  if (!(await fs.lstat(ready).catch(() => null))?.isFile()) return null;
  // No other host may see a ready marker until this owner releases it.
  try { await fs.rename(ready, busy); } catch { return null; }
  try {
    const receipt = JSON.parse(await fs.readFile(busy, 'utf8'));
    if (receipt.version !== 1 || !SHA.test(receipt.sha) ||
        typeof receipt.common !== 'string' || typeof receipt.name !== 'string' ||
        path.basename(receipt.name) !== receipt.name || !Number.isFinite(receipt.lastActive)) return null;
    return receipt;
  } catch { return null; } // Unknown/crashed slots remain quarantined.
}
async function release(directory, receipt) {
  await fs.writeFile(path.join(directory, BUSY), JSON.stringify(receipt), { mode: 0o600 });
  await fs.rename(path.join(directory, BUSY), path.join(directory, READY));
}
async function valid(directory, receipt, run) {
  const root = path.join(directory, receipt.name);
  if (!await plain(root)) return false;
  try {
    const repo = await identity(root, run);
    if (!repo || repo.common !== receipt.common ||
        !path.basename(directory).startsWith('.prepared-' + repo.hash + '-')) return false;
    return await run(['-C', root, 'branch', '--show-current']) === '' &&
      await run(['-C', root, 'rev-parse', 'HEAD']) === receipt.sha &&
      await run(['-C', root, 'status', '--porcelain', '--untracked-files=all', '--ignored']) === '';
  } catch { return false; }
}
async function reachable(receipt, run) {
  return Boolean(await run(['--git-dir=' + receipt.common, 'for-each-ref',
    '--contains=' + receipt.sha, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']));
}
async function retire(directory, receipt, run) {
  if (!await valid(directory, receipt, run) || !await reachable(receipt, run)) return false;
  // No force, reset, recursive filesystem deletion or branch deletion.
  await run(['--git-dir=' + receipt.common, 'worktree', 'remove', '--', path.join(directory, receipt.name)]);
  await fs.unlink(path.join(directory, BUSY));
  await fs.rmdir(directory).catch(() => {});
  return true;
}
async function localBase(repo, run) {
  const local = args => run(['-C', repo.original, ...args]);
  let name = await local(['config', '--local', '--get', 'sweetiebot.default-branch']).catch(() => '');
  if (!name) name = await local(['config', '--local', '--get', 'scm-toolkit.default-branch']).catch(() => '');
  if (!name) {
    const ref = await local(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '');
    name = ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : 'main';
  }
  const sha = await local(['rev-parse', '--verify', 'refs/heads/' + name + '^{commit}']).catch(() => '');
  return SHA.test(sha) ? sha : null;
}
async function maintain(root, { base = independentWorkspaceParent(), count = 3, run = git, now = Date.now() } = {}) {
  const repo = await identity(root, run);
  if (!repo) return null;
  const sha = await localBase(repo, run);
  if (!sha) return repo.common;
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  if (!await plain(base)) return repo.common;
  const directories = slots(base, repo, count);
  const parent = path.dirname(directories[0]);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (!await plain(parent)) return repo.common;
  // No checkout hooks or dependency installs run for an unused standby.
  // Git's normal checkout filters still apply; only trusted workspaces warm.
  for (const directory of directories) {
    const started = performance.now();
    try {
      const existing = await readClaim(directory);
      if (existing) {
        if (existing.common !== repo.common || !await valid(directory, existing, run)) continue;
        if (existing.sha === sha) {
          await release(directory, { ...existing, lastActive: now });
          continue;
        }
        if (!await retire(directory, existing, run)) continue;
      }
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      const destination = path.join(directory, repo.name);
      const receipt = { version: 1, common: repo.common, name: repo.name, sha, lastActive: now };
      // An interrupted add leaves an unready directory; never delete unknown
      // contents or assume a partial Git operation was rolled back.
      await run(['-C', repo.original, '-c', 'core.hooksPath=/dev/null',
        'worktree', 'add', '--detach', '--quiet', '--', destination, sha]);
      if (!await valid(directory, receipt, run)) continue;
      await release(directory, receipt);
      timing('Prepared checkout', started);
    } catch (error) { output?.appendLine('Standby preparation deferred: ' + error.code); }
  }
  return repo.common;
}
async function consume(original, destination, branch, start, {
  base = independentWorkspaceParent(), count = 3, run = git
} = {}) {
  const repo = await identity(original, run);
  if (!repo || !await plain(base)) return false;
  const sha = await run(['-C', original, 'rev-parse', '--verify', (start || 'main') + '^{commit}']);
  if (!SHA.test(sha)) return false;
  for (const directory of slots(base, repo, count)) {
    if (!await plain(path.dirname(directory))) continue;
    const receipt = await readClaim(directory);
    if (!receipt) continue;
    if (receipt.common !== repo.common || !await valid(directory, receipt, run)) continue;
    if (receipt.sha !== sha) { await release(directory, receipt); continue; }
    const source = path.join(directory, repo.name);
    try {
      // Git moves both the filesystem and registry, preserving worktree IDs.
      // Do not replace an existing path or force a checkout.
      await run(['-C', original, 'worktree', 'move', '--', source, destination]);
    } catch (error) {
      // A timeout may have moved it despite reporting failure. Preserve the
      // target in that case; never allow the caller to recursively remove it.
      if (await fs.lstat(destination).catch(() => null)) {
        error.preservePrepared = true;
        throw error;
      }
      if (await valid(directory, receipt, run)) await release(directory, receipt);
      continue;
    }
    // From here on, destination is registered even if switching fails.
    try {
      await run(['-C', destination, 'switch', '-c', branch, sha]);
    } catch (error) { error.preservePrepared = true; throw error; }
    await fs.unlink(path.join(directory, BUSY)).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
    return true;
  }
  return false;
}
async function reap(base, active, { run = git, now = Date.now(), idleMs = IDLE_MS, count = 3 } = {}) {
  if (!await plain(base)) return;
  for (const parent of await fs.readdir(base)) {
    const folder = path.join(base, parent);
    if (!await plain(folder)) continue;
    for (const entry of await fs.readdir(folder)) {
      if (!SLOT.test(entry)) continue;
      const directory = path.join(folder, entry);
      // Avoid briefly claiming a live slot merely to read its age.
      if (!await plain(directory)) continue;
      let peek;
      try { peek = JSON.parse(await fs.readFile(path.join(directory, READY), 'utf8')); }
      catch { continue; }
      if (active.has(peek.common) && Number(entry.split('-').pop()) <= count) continue;
      if (now - peek.lastActive < idleMs) continue;
      const receipt = await readClaim(directory);
      if (!receipt) continue;
      if (now - receipt.lastActive < idleMs ||
          (active.has(receipt.common) && Number(entry.split('-').pop()) <= count)) {
        await release(directory, receipt); continue;
      }
      try { await retire(directory, receipt, run); }
      catch { /* Leave a failed or ambiguous cleanup quarantined. */ }
    }
  }
}
function registerPreparedWorktrees(vscode, context) {
  let disposed = false, running = false, initial = true;
  if (vscode.window?.createOutputChannel) {
    output = vscode.window.createOutputChannel('Sweetiebot Branch Performance');
    context.subscriptions.push(output);
  }
  const scan = async () => {
    if (disposed || running || vscode.workspace.isTrusted === false) return;
    running = true;
    try {
      const settings = config(vscode), base = independentWorkspaceParent();
      const active = new Set();
      const extension = vscode.extensions?.getExtension?.('vscode.git');
      if (!extension) return;
      const api = (await extension.activate()).getAPI(1);
      for (const repository of api.repositories || []) {
        if (disposed || repository.rootUri?.scheme !== 'file') continue;
        const root = repository.rootUri.fsPath;
        const repo = await identity(root, git).catch(() => null);
        if (!repo || active.has(repo.common)) continue;
        // Prepared paths themselves must never trigger pool maintenance.
        if (root.split(path.sep).some(part => SLOT.test(part))) continue;
        active.add(repo.common);
        if (settings.enabled && (initial || settings.replenish))
          await maintain(root, { base, count: settings.count }).catch(() => {});
      }
      initial = false;
      await reap(base, settings.enabled ? active : new Set(), {
        idleMs: settings.idleMs, count: settings.count
      });
    } finally { running = false; }
  };
  const run = () => void scan().catch(() => {});
  // Give branch selection and extension activation priority over warming.
  const first = setTimeout(run, 2000);
  const timer = setInterval(run, SCAN_MS);
  first.unref?.(); timer.unref?.();
  context.subscriptions.push({ dispose() { disposed = true; clearTimeout(first); clearInterval(timer); } });
}
module.exports = { config, maintain, consume, reap, timing, registerPreparedWorktrees };
