'use strict';

const { access } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');

function kefaniaCandidates(repositoryPath, { home = homedir(), moduleDirectory = __dirname } = {}) {
  const parent = path.dirname(path.resolve(repositoryPath));
  return [...new Set([
    path.join(parent, 'kefania'),
    path.join(path.dirname(parent), 'pony-factor', 'kefania'),
    path.resolve(moduleDirectory, '..', '..', '..', 'kefania'),
    path.join(home, 'GitHub', 'pony-factor', 'kefania'),
  ])];
}

async function resolveKefaniaFile(repositoryPath, relativePath, options = {}) {
  const candidates = kefaniaCandidates(repositoryPath, options);
  for (const directory of candidates) {
    const file = path.join(directory, relativePath);
    try {
      await (options.accessFile || access)(file);
      return file;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('Kefania was not found. Keep an updated checkout beside this repository or at ~/GitHub/pony-factor/kefania, with npm dependencies installed.');
}

module.exports = { kefaniaCandidates, resolveKefaniaFile };
