'use strict';

const fs = require('fs');
const path = require('path');

// VS Code may load its previous cached user-extension manifest on the first
// workbench reload, then notice the companion extension changed on disk and
// request another reload. The scan result is disposable; let VS Code rebuild it
// from the newly installed extensions during the *first* reload instead.
function userExtensionCachePath(context) {
  const storagePath = context.globalStorageUri?.fsPath;
  if (!storagePath) return;
  const extensionStorage = path.resolve(storagePath);
  if (path.basename(path.dirname(extensionStorage)) !== 'globalStorage') return;
  let folder = path.dirname(extensionStorage);
  // Default: Code/User/globalStorage/<id>; profiles can nest under User/profiles.
  while (path.basename(folder) !== 'User') {
    const parent = path.dirname(folder);
    if (parent === folder) return;
    folder = parent;
  }
  return path.join(path.dirname(folder), 'CachedExtensions', 'user');
}

function invalidateUserExtensionCache(context, output) {
  const filename = userExtensionCachePath(context);
  if (!filename) return false;
  try {
    // Never follow a symlink or remove directories. Only the disposable scan
    // result is affected, not installed extension data or VS Code preferences.
    if (!fs.lstatSync(filename).isFile()) return false;
    fs.unlinkSync(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    output?.appendLine(
      `Could not reset the VS Code user-extension cache (${error.code || 'unknown error'}); another reload may be needed.`
    );
    return false;
  }
}

module.exports = { userExtensionCachePath, invalidateUserExtensionCache };
