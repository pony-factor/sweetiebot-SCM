'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomInt } = require('node:crypto');

// Readable color suffixes replace opaque workspace UUIDs.
const COLORS = Object.freeze([
  'amber', 'aqua', 'azure', 'bronze', 'coral', 'crimson', 'emerald', 'gold',
  'indigo', 'ivory', 'jade', 'lavender', 'lilac', 'lime', 'mint', 'navy',
  'ochre', 'olive', 'peach', 'periwinkle', 'pink', 'plum', 'rose', 'ruby',
  'saffron', 'scarlet', 'silver', 'teal', 'turquoise', 'violet'
]);

function branchLabel(branch) {
  // Git branches may contain slashes; never turn them into nested directories.
  return String(branch || 'main').replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '').slice(0, 96) || 'branch';
}

function workspaceFileName(directory) {
  return path.basename(directory) + '.code-workspace';
}

async function createWorkspaceDirectory(baseDirectory, repository, io = fs, {
  branch = 'main', randomIndex = randomInt
} = {}) {
  const label = repository.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
  if (label === '.' || label === '..') throw new Error('Invalid repository name');
  const parent = path.join(baseDirectory, label);
  await io.mkdir(parent, { recursive: true });
  if (!(await io.lstat(parent)).isDirectory()) throw new Error('Unsafe repository workspace folder');

  const prefix = branchLabel(branch);
  // Plain mkdir atomically reserves the name. Retry on collision without
  // overwriting existing workspaces; the color stays the final suffix.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const color = COLORS[randomIndex(COLORS.length)];
    const ordinal = attempt ? '-' + (attempt + 1) : '';
    const directory = path.join(parent, prefix + ordinal + '-' + color);
    try {
      await io.mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate an unused Sweetiebot workspace directory');
}

// Accept both legacy flat workspaces and repository/ID workspaces. Reject
// symlinked repository parents before activity tracking or cleanup uses them.
async function isWorkspaceDirectory(io, group, baseDirectory) {
  const parent = path.dirname(group);
  if (parent === baseDirectory) return true;
  if (path.dirname(parent) !== baseDirectory) return false;
  try { return (await io.lstat(parent)).isDirectory(); }
  catch { return false; }
}

module.exports = { createWorkspaceDirectory, isWorkspaceDirectory, workspaceFileName };
