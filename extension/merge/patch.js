'use strict';

const path = require('node:path');
function safePatchPath(name) {
  return typeof name === 'string' && name && !path.isAbsolute(name) && !name.startsWith(':') && !/[\\\x00-\x1f]/.test(name) &&
    !name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' ||
      /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc)$/i.test(part) ||
      /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));
}

const renameHeader = /^rename (?:from|to) /m;

async function inspectResolutionPatch(patch, filename, git) {
  const numstat = await git('apply', '--numstat', '-z', '--', filename);
  // Git reports only the destination of a rename in forward numstat.
  const originalNumstat = renameHeader.test(patch)
    ? await git('apply', '--reverse', '--numstat', '-z', '--', filename)
    : undefined;
  return patchPaths(patch, numstat, originalNumstat);
}

function patchPaths(patch, numstat, originalNumstat) {
  if (/^(?:GIT binary patch|Binary files |copy from |copy to )/m.test(patch) ||
      /^(?:(?:new|deleted) file mode|old mode|new mode) (?:120000|160000)$/m.test(patch)) {
    throw Error('Resolution patches support regular text files and moves of existing regular files. Omit binary patch data, copies, symlinks and submodules.');
  }
  if (renameHeader.test(patch) && typeof originalNumstat !== 'string') {
    throw Error('Both paths of a resolution rename must be verified by Git.');
  }
  const parse = stats => stats.split('\0').filter(Boolean).map(line => {
    const match = /^\d+\t\d+\t([^\0]+)$/.exec(line);
    if (!match || !safePatchPath(match[1])) {
      throw Error('Resolution patch contains an unsafe or secret-bearing path.');
    }
    return match[1];
  });
  const destinations = parse(numstat);
  const sources = renameHeader.test(patch) ? parse(originalNumstat) : destinations;
  if (!destinations.length || sources.length !== destinations.length ||
      new Set(destinations).size !== destinations.length || new Set(sources).size !== sources.length) {
    throw Error('Resolution patch has no unique changed files.');
  }
  return [...new Set([...sources, ...destinations])].sort();
}
module.exports = { safePatchPath, patchPaths, inspectResolutionPatch };
