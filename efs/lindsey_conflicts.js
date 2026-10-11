'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const git = async (cwd, args) => (await exec('git', args, {
  cwd, timeout: 15000, maxBuffer: 1024 * 1024
})).stdout.trim();

function lindseyScript(repoRoot, folders = [], configured = process.env.LINDSEY_SYNC_REPO) {
  const candidates = [configured, path.join(path.dirname(repoRoot), 'lindsey-sync'),
    ...folders.map(folder => folder?.uri?.fsPath || folder?.fsPath || '')].filter(Boolean);
  for (const directory of candidates) {
    const script = path.resolve(directory, 'scripts', 'resolve-conflicts.js');
    if (existsSync(script)) return script;
  }
  throw new Error('Lindsey Sync is not available locally. Open the lindsey-sync repository in this VS Code workspace, put it beside this repository, or set LINDSEY_SYNC_REPO.');
}

function isConflictState(repository) {
  return Boolean(repository.state?.mergeChanges?.length);
}

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && relative.length <= 1024
    && !path.isAbsolute(relative) && !relative.includes('\\')
    && !relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')
    && !/[\x00-\x1f]/.test(relative);
}
function inside(root, relative) {
  if (!safeRelative(relative)) throw new Error('Lindsey returned an unsafe file path.');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Lindsey returned a path outside the workspace.');
  }
  return resolved;
}

async function inspectPreview(repository, temporary, manifest) {
  const root = repository.rootUri?.fsPath;
  if (!root || manifest?.version !== 1 || !Array.isArray(manifest.files)
      || !manifest.files.length || manifest.files.length > 8
      || !/^[a-f0-9]{40,64}$/i.test(manifest.head || '')) {
    throw new Error('Lindsey returned an invalid conflict preview.');
  }
  if ((await git(root, ['rev-parse', 'HEAD'])) !== manifest.head
      || (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== manifest.branch) {
    throw new Error('The active branch advanced during conflict resolution. No changes were made.');
  }
  const seen = new Set(), files = [];
  for (const entry of manifest.files) {
    if (!safeRelative(entry?.path) || seen.has(entry.path)
        || !safeRelative(entry?.candidate) || entry.candidate.includes('/')
        || !/^[a-f0-9]{64}$/i.test(entry.originalSha || '')) {
      throw new Error('Lindsey returned an invalid or duplicate conflict file.');
    }
    seen.add(entry.path);
    const target = inside(root, entry.path);
    const candidate = inside(temporary, entry.candidate);
    const stat = await fs.lstat(target);
    const proposalStat = await fs.lstat(candidate);
    if (!stat.isFile() || !proposalStat.isFile() || proposalStat.size > 256 * 1024) {
      throw new Error('Conflict resolution only supports regular text files up to 256 KiB.');
    }
    if (!(await git(root, ['ls-files', '-u', '--', entry.path]))) {
      throw new Error(entry.path + ' is no longer an unresolved conflict.');
    }
    const original = await fs.readFile(target);
    if (sha256(original) !== entry.originalSha) {
      throw new Error(entry.path + ' changed while Lindsey was preparing its proposal.');
    }
    const proposed = await fs.readFile(candidate);
    if (proposed.includes(0) || proposed.toString('utf8').includes('\uFFFD')) {
      throw new Error('Lindsey returned invalid text for ' + entry.path);
    }
    files.push({ path: entry.path, target, candidate, original, proposed });
  }
  return files;
}

async function applyPreview(repository, temporary, manifest) {
  const files = await inspectPreview(repository, temporary, manifest);
  const applied = [];
  try {
    for (const file of files) {
      if (sha256(await fs.readFile(file.target)) !== sha256(file.original)) {
        throw new Error(file.path + ' was edited during approval. No further proposals were applied.');
      }
      await fs.writeFile(file.target, file.proposed);
      applied.push(file);
    }
  } catch (error) {
    for (const file of applied.reverse()) await fs.writeFile(file.target, file.original);
    throw error;
  }
  await repository.status();
  return files.length;
}

async function generatePreview(vscode, repository) {
  const root = repository.rootUri?.fsPath;
  if (!root) throw new Error('No local Git repository selected.');
  const script = lindseyScript(root, vscode.workspace?.workspaceFolders || []);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-lindsey-'));
  try {
    const { stdout } = await exec(process.execPath,
      [script, '--repo', root, '--output', temporary], {
        cwd: root, timeout: 180000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      });
    const manifest = JSON.parse(stdout);
    const files = await inspectPreview(repository, temporary, manifest);
    for (const file of files) {
      await vscode.commands.executeCommand('vscode.diff',
        vscode.Uri.file(file.target), vscode.Uri.file(file.candidate),
        'Lindsey proposal: ' + file.path);
    }
    const approval = await vscode.window.showWarningMessage(
      'Review the Lindsey diff editors. Apply ' + files.length + ' proposed resolution(s) to the working tree? Nothing will be staged, committed or pushed.',
      { modal: true }, 'Apply proposed resolutions');
    if (approval !== 'Apply proposed resolutions') return undefined;
    const applied = await applyPreview(repository, temporary, manifest);
    void vscode.window.showInformationMessage(
      'Applied Lindsey proposals to ' + applied + ' file(s). Review, stage and commit the results yourself.');
    return undefined;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function offerConflictRecoveryOptions(vscode, repository, propose = generatePreview) {
  const choice = await vscode.window.showQuickPick([
    { id: 'lindsey', label: '$(sparkle) Resolve with Lindsey', description: 'Preview AI proposals from a local lindsey-sync checkout' },
    { id: 'review', label: '$(diff) Review conflicts', description: 'Inspect conflicted files in Source Control' },
    { id: 'manual', label: '$(tools) Resolve manually', description: 'Open the merge editor' },
    { id: 'output', label: '$(output) Show Git output', description: 'Inspect Git diagnostics' },
    { id: 'cancel', label: '$(circle-slash) Cancel', description: 'Leave conflicts and files untouched' }
  ], { title: 'Merge conflicts need resolution', placeHolder: 'Choose a recovery action', ignoreFocusOut: true });
  if (choice?.id === 'lindsey') return propose(vscode, repository);
  if (choice?.id === 'output') return vscode.commands.executeCommand('git.showOutput');
  if (choice?.id === 'review' || choice?.id === 'manual') {
    await vscode.commands.executeCommand('workbench.view.scm');
    if (choice.id === 'manual') {
      const uri = repository.state?.mergeChanges?.[0]?.resourceUri;
      if (uri) try { await vscode.commands.executeCommand('git.openMergeEditor', uri); }
      catch { /* Keep Source Control open when the merge editor is unavailable. */ }
    }
  }
  return undefined;
}

module.exports = { isConflictState, lindseyScript, safeRelative, inspectPreview,
  applyPreview, generatePreview, offerConflictRecoveryOptions };
