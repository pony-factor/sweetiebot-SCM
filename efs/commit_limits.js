'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIB = 1024 * 1024;
const GITHUB_FILE_WARNING_BYTES = 50 * MIB;
const GITHUB_FILE_MAX_BYTES = 100 * MIB;
const SPLIT_PART_BYTES = 95 * MIB;
const SPLIT_IO_BYTES = 8 * MIB;
const GITHUB_DIFF_MAX_LINES = 20_000;
const GITHUB_DIFF_MAX_BYTES = 1_000_000;
const GITHUB_DIFF_MAX_FILES = 300;
const GITHUB_DIFF_MAX_RENDERABLE_FILES = 25;
const GITHUB_FILE_DIFF_MAX_LINES = 20_000;
const GITHUB_FILE_DIFF_MAX_BYTES = 500_000;
const RENDERABLE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg',
  '.tif', '.tiff', '.webp', '.pdf', '.geojson'
]);

function gitBuffer(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `git exited with ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

function countLines(buffer) {
  if (!buffer.length) return 0;
  let count = 0;
  for (const byte of buffer) if (byte === 10) count += 1;
  return count + (buffer[buffer.length - 1] === 10 ? 0 : 1);
}

function splitRawDiffSections(buffer) {
  const marker = Buffer.from('diff --git ');
  const starts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const found = buffer.indexOf(marker, offset);
    if (found < 0) break;
    if (found === 0 || buffer[found - 1] === 10) starts.push(found);
    offset = found + marker.length;
  }
  return starts.map((start, index) =>
    buffer.subarray(start, index + 1 < starts.length ? starts[index + 1] : buffer.length)
  );
}

function renderableCount(files) {
  return files.reduce(
    (count, file) => count + Number(RENDERABLE_EXTENSIONS.has(path.extname(file).toLowerCase())),
    0
  );
}

function evaluateCommitLimits({ files, blobs, rawDiff }) {
  const hardErrors = [];
  const warnings = [];
  const oversized = blobs.filter(item => item.size > GITHUB_FILE_MAX_BYTES);
  if (oversized.length) {
    const sample = oversized.slice(0, 3)
      .map(item => `${item.path} (${(item.size / MIB).toFixed(1)} MiB)`)
      .join(', ');
    hardErrors.push(
      `GitHub blocks regular Git files larger than 100 MiB: ${sample}`
      + (oversized.length > 3 ? ` and ${oversized.length - 3} more` : '')
      + '. Splitting the commit cannot shrink the final blob; split the file itself or use Git LFS.'
    );
  }
  const large = blobs.filter(item =>
    item.size > GITHUB_FILE_WARNING_BYTES && item.size <= GITHUB_FILE_MAX_BYTES
  );
  if (large.length) {
    warnings.push(
      `${large.length} staged file${large.length === 1 ? '' : 's'} exceed GitHub's 50 MiB warning threshold`
    );
  }

  const totalLines = countLines(rawDiff);
  if (totalLines > GITHUB_DIFF_MAX_LINES) {
    warnings.push(`the diff has ${totalLines.toLocaleString()} lines (GitHub loads up to 20,000)`);
  }
  if (rawDiff.length > GITHUB_DIFF_MAX_BYTES) {
    warnings.push(`the raw diff is ${(rawDiff.length / 1_000_000).toFixed(2)} MB (GitHub loads up to 1 MB)`);
  }
  if (files.length > GITHUB_DIFF_MAX_FILES) {
    warnings.push(`${files.length} files are changed (GitHub displays up to 300 in one diff)`);
  }
  const renderables = renderableCount(files);
  if (renderables > GITHUB_DIFF_MAX_RENDERABLE_FILES) {
    warnings.push(`${renderables} renderable files are changed (GitHub displays up to 25)`);
  }

  const sections = splitRawDiffSections(rawDiff);
  if (sections.some(section => countLines(section) > GITHUB_FILE_DIFF_MAX_LINES)) {
    warnings.push('at least one file diff exceeds GitHub\'s 20,000-line per-file display limit');
  }
  if (sections.some(section => section.length > GITHUB_FILE_DIFF_MAX_BYTES)) {
    warnings.push('at least one file diff exceeds GitHub\'s 500 KB per-file display limit');
  }
  return { hardErrors, warnings, oversized };
}

async function gitExitCode(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}

function splitPartPaths(relativePath, size, partBytes = SPLIT_PART_BYTES) {
  const count = Math.ceil(size / partBytes);
  const width = Math.max(3, String(count).length);
  return Array.from(
    { length: count },
    (_, index) => `${relativePath}.part${String(index + 1).padStart(width, '0')}`
  );
}

function safeWorkspacePath(cwd, relativePath) {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to split a path outside the repository: ${relativePath}`);
  }
  return resolved;
}

async function splitOversizedFile(cwd, item, partBytes = SPLIT_PART_BYTES) {
  const relativePath = item.path;
  const sourcePath = safeWorkspacePath(cwd, relativePath);
  const stat = await fs.promises.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular working-tree file`);
  }
  if (stat.size !== item.size) {
    throw new Error(
      `${relativePath} changed after staging; stage the current file before splitting it`
    );
  }

  const unstaged = await gitExitCode(cwd, ['diff', '--quiet', '--', relativePath]);
  if (unstaged === 1) {
    throw new Error(
      `${relativePath} has unstaged changes; stage or discard them before splitting`
    );
  }
  if (unstaged !== 0) {
    throw new Error(`Git could not verify the working-tree copy of ${relativePath}`);
  }

  const partPaths = splitPartPaths(relativePath, item.size, partBytes);
  const partAbsolutePaths = partPaths.map(part => safeWorkspacePath(cwd, part));
  for (const partPath of partAbsolutePaths) {
    try {
      await fs.promises.lstat(partPath);
      throw new Error(`Refusing to overwrite existing split part: ${path.relative(cwd, partPath)}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const token = `${process.pid}-${Date.now()}`;
  const tempPaths = partAbsolutePaths.map((partPath, index) =>
    `${partPath}.scm-toolkit-${token}-${index + 1}`
  );
  const backupPath = `${sourcePath}.scm-toolkit-original-${token}`;
  let source;
  let sourceMoved = false;
  let finalsCreated = false;

  try {
    source = await fs.promises.open(sourcePath, 'r');
    let offset = 0;
    for (let index = 0; index < tempPaths.length; index += 1) {
      const target = await fs.promises.open(tempPaths[index], 'wx', stat.mode & 0o777);
      try {
        let remaining = Math.min(partBytes, item.size - offset);
        const buffer = Buffer.allocUnsafe(Math.min(SPLIT_IO_BYTES, Math.max(1, remaining)));
        while (remaining > 0) {
          const request = Math.min(buffer.length, remaining);
          const { bytesRead } = await source.read(buffer, 0, request, offset);
          if (!bytesRead) throw new Error(`Unexpected end of file while splitting ${relativePath}`);
          await target.write(buffer, 0, bytesRead);
          offset += bytesRead;
          remaining -= bytesRead;
        }
        await target.chmod(stat.mode & 0o777);
      } finally {
        await target.close();
      }
    }
    await source.close();
    source = undefined;

    await fs.promises.rename(sourcePath, backupPath);
    sourceMoved = true;
    for (let index = 0; index < tempPaths.length; index += 1) {
      await fs.promises.rename(tempPaths[index], partAbsolutePaths[index]);
    }
    finalsCreated = true;

    await gitBuffer(cwd, ['add', '-A', '--', relativePath, ...partPaths]);
    await fs.promises.unlink(backupPath);
    sourceMoved = false;
    return partPaths;
  } catch (error) {
    try { await source?.close(); } catch {}
    for (const tempPath of tempPaths) {
      try { await fs.promises.unlink(tempPath); } catch {}
    }
    if (finalsCreated) {
      for (const partPath of partAbsolutePaths) {
        try { await fs.promises.unlink(partPath); } catch {}
      }
    }
    if (sourceMoved) {
      try { await fs.promises.rename(backupPath, sourcePath); } catch {}
      try { await gitBuffer(cwd, ['add', '--', relativePath]); } catch {}
    }
    throw error;
  }
}

async function stagedBlobSizes(cwd, files) {
  if (!files.length) return [];
  const entries = await gitBuffer(cwd, ['ls-files', '--stage', '-z', '--', ...files]);
  const shas = new Map();
  for (const entry of entries.toString('utf8').split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const metadata = entry.slice(0, tab).trim().split(/\s+/);
    if (metadata.length < 3 || metadata[2] !== '0') continue;
    shas.set(entry.slice(tab + 1), metadata[1]);
  }

  const unique = [...new Set(shas.values())];
  const sizes = new Map();
  if (unique.length) {
    const checked = await gitBuffer(
      cwd,
      ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
      Buffer.from(unique.join('\n') + '\n')
    );
    for (const line of checked.toString('ascii').trim().split('\n')) {
      if (!line) continue;
      const [sha, size] = line.trim().split(/\s+/, 2);
      sizes.set(sha, Number(size));
    }
  }
  return files.map(file => ({ path: file, size: sizes.get(shas.get(file)) || 0 }));
}

async function inspectCommitLimits(cwd) {
  const names = await gitBuffer(cwd, ['diff', '--cached', '--name-only', '-z', '--no-ext-diff']);
  const files = names.toString('utf8').split('\0').filter(Boolean);
  if (!files.length) return { hardErrors: [], warnings: [] };
  const [rawDiff, blobs] = await Promise.all([
    gitBuffer(cwd, ['diff', '--cached', '--no-ext-diff', '--no-color']),
    stagedBlobSizes(cwd, files)
  ]);
  return evaluateCommitLimits({ files, blobs, rawDiff });
}

async function confirmCommitLimits(vscode, cwd, status) {
  if (status.oversized?.length) {
    const splitLabel = status.oversized.length === 1 ? 'Split file' : 'Split files';
    const names = status.oversized.slice(0, 3)
      .map(item => `${item.path} (${(item.size / MIB).toFixed(1)} MiB)`)
      .join(', ');
    const action = await vscode.window.showErrorMessage(
      `GitHub blocks regular Git files larger than 100 MiB: ${names}`
        + (status.oversized.length > 3 ? ` and ${status.oversized.length - 3} more` : '')
        + `. ${splitLabel} will replace each oversized working-tree file with numbered `
        + `.part001, .part002, … files of at most 95 MiB and stage the replacement. `
        + 'The original file is removed only after the split and staging succeed.',
      { modal: true },
      splitLabel,
      'Git LFS docs',
      'Cancel'
    );
    if (action === 'Git LFS docs') {
      await vscode.env.openExternal(vscode.Uri.parse(
        'https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage'
      ));
      return false;
    }
    if (action !== splitLabel) return false;

    try {
      const created = [];
      for (const item of status.oversized) {
        created.push(...await splitOversizedFile(cwd, item));
      }
      await vscode.window.showInformationMessage(
        `Split oversized file${status.oversized.length === 1 ? '' : 's'} into `
          + `${created.length} staged parts. Recombine parts in order to restore the original bytes.`
      );
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not split oversized file: ${error.message}`);
      return false;
    }

    const refreshed = await inspectCommitLimits(cwd);
    if (refreshed.oversized?.length) return false;
    return confirmCommitLimits(vscode, cwd, refreshed);
  }
  if (status.hardErrors.length) {
    await vscode.window.showErrorMessage(status.hardErrors.join(' '));
    return false;
  }
  if (!status.warnings.length) return true;
  const action = await vscode.window.showWarningMessage(
    `GitHub may warn about or truncate this commit on the web: ${status.warnings.join('; ')}.`,
    { modal: false },
    'Commit anyway'
  );
  return action === 'Commit anyway';
}

function registerCommitLimitCommand(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand(
    'scmToolkit.checkCommitLimits',
    async uri => {
      const root = vscode.Uri.from(uri?.rootUri ?? uri);
      if (root.scheme !== 'file') return true;
      const status = await inspectCommitLimits(root.fsPath);
      return confirmCommitLimits(vscode, root.fsPath, status);
    }
  ));
}

module.exports = {
  MIB,
  GITHUB_FILE_MAX_BYTES,
  SPLIT_PART_BYTES,
  countLines,
  splitRawDiffSections,
  evaluateCommitLimits,
  splitPartPaths,
  splitOversizedFile,
  inspectCommitLimits,
  confirmCommitLimits,
  registerCommitLimitCommand
};
