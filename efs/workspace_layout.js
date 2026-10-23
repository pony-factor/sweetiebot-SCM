'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function createWorkspaceDirectory(baseDirectory, repository, io = fs) {
  const label = repository.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
  if (label === '.' || label === '..') throw new Error('Invalid repository name');
  const parent = path.join(baseDirectory, label);
  await io.mkdir(parent, { recursive: true });
  if (!(await io.lstat(parent)).isDirectory()) throw new Error('Unsafe repository workspace folder');
  const directory = path.join(parent, randomUUID());
  await io.mkdir(directory);
  return directory;
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

module.exports = { createWorkspaceDirectory, isWorkspaceDirectory };
