'use strict';

const path = require('node:path');
function safePatchPath(name) {
  return typeof name === 'string' && name && !path.isAbsolute(name) && !/[\\\x00-\x1f]/.test(name) &&
    !name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' ||
      /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc)$/i.test(part) ||
      /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));
}

function patchPaths(patch, numstat, allowedPaths) {
  if (/^(?:GIT binary patch|Binary files |rename from |rename to |copy from |copy to )/m.test(patch) ||
      /^(?:(?:new|deleted) file mode|old mode|new mode) (?:120000|160000)$/m.test(patch)) {
    throw Error('Resolution patches support regular text files only; no binary, symlink, submodule or rename changes.');
  }
  const paths = numstat.split('\0').filter(Boolean).map(line => {
    const match = /^\d+\t\d+\t([^\0]+)$/.exec(line);
    if (!match || !safePatchPath(match[1]) || !allowedPaths.includes(match[1])) {
      throw Error('Resolution patch contains an unsafe, secret-bearing or unrelated path.');
    }
    return match[1];
  });
  if (!paths.length || new Set(paths).size !== paths.length) throw Error('Resolution patch has no unique changed files.');
  return paths.sort();
}
module.exports = { safePatchPath, patchPaths };
