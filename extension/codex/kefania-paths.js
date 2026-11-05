'use strict';

const { access, readdir, realpath } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { homedir } = require('node:os');
const path = require('node:path');
const exec = promisify(execFile);

async function git(args) {
  return (await exec('git', args, {
    timeout: 5000, maxBuffer: 64 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim();
}

function isKefaniaRemote(remote) {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)pony-factor\/kefania(?:-PR)?(?:\.git)?\/?$/i.test(remote);
}

async function isKefaniaCheckout(directory, run = git) {
  try {
    const root = await run(['-C', directory, 'rev-parse', '--show-toplevel']);
    // Git searches parent directories. A nested folder must not inherit its
    // parent's identity and be mistaken for the service checkout.
    if (await realpath(root) !== await realpath(directory)) return false;
    return isKefaniaRemote(await run(['-C', directory, 'remote', 'get-url', 'origin']));
  } catch {
    // Never surface Git stderr: remote URLs can contain credentials.
    return false;
  }
}

async function childDirectories(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => !entry.name.startsWith('.') &&
      (entry.isDirectory() || entry.isSymbolicLink()))
      .map(entry => path.join(directory, entry.name)).sort();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
    throw error;
  }
}

function kefaniaCandidates(repositoryPath, { home = homedir(), moduleDirectory = __dirname } = {}) {
  const parent = path.dirname(path.resolve(repositoryPath));
  const candidates = [
    path.join(parent, 'kefania'),
    path.join(path.dirname(parent), 'pony-factor', 'kefania'),
    path.resolve(moduleDirectory, '..', '..', '..', 'kefania'),
    path.join(home, 'GitHub', 'pony-factor', 'kefania'),
  ];
  // The PR service may be checked out as kefania-PR. Keep the existing
  // kefania locations first, including for disposable trial repositories.
  return [...new Set([...candidates, ...candidates.map(directory => directory + '-PR')])];
}

async function resolveKefaniaFile(repositoryPath, relativePath, options = {}) {
  const candidates = kefaniaCandidates(repositoryPath, options);
  const seen = new Set();
  async function resolveCandidate(directory) {
    if (seen.has(directory)) return null;
    seen.add(directory);
    // Establish Git identity before probing the file: unrelated or protected
    // sibling directories must not prevent discovery of a valid checkout.
    if (!await isKefaniaCheckout(directory, options.git || git)) return null;
    const file = path.join(directory, relativePath);
    try {
      await (options.accessFile || access)(file);
      return file;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      return null;
    }
  }
  for (const directory of candidates) {
    const file = await resolveCandidate(directory);
    if (file) return file;
  }
  // Search only neighboring checkouts and the two usual GitHub levels.
  // Names are hints; only the checkout root and Git origin establish identity.
  const github = path.join(options.home || homedir(), 'GitHub');
  const owners = await childDirectories(github);
  const parents = [...new Set([...candidates.map(directory => path.dirname(directory)), github, ...owners])];
  for (const parent of parents) {
    for (const directory of await childDirectories(parent)) {
      const file = await resolveCandidate(directory);
      if (file) return file;
    }
  }
  throw new Error('Kefania was not found. Keep a checkout of pony-factor/kefania-PR (or pony-factor/kefania) beside this repository or under ~/GitHub, with its Git origin and npm dependencies installed. The directory name can be anything.');
}

module.exports = { kefaniaCandidates, resolveKefaniaFile, isKefaniaRemote };
