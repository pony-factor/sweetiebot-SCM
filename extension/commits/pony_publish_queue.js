'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { enqueue: enqueueBackground } = require('./background_commit');
const { pendingPonyProfiles } = require('./pony_git_publish');

// Installed extensions package the worker beside package.json, while a source
// checkout retains it in scripts/. Never escape the installed extension root
// to ~/.vscode/extensions/scripts if its packaged worker is missing.
function resolvePonyWorkerScript(directory = __dirname, exists = fs.existsSync) {
  const moduleDirectory = path.resolve(directory);
  const installed = path.resolve(moduleDirectory, '../background_commit.py');
  if (exists(installed)) return installed;
  if (path.basename(path.dirname(moduleDirectory)) === 'extension') {
    const source = path.resolve(moduleDirectory, '../../scripts/background_commit.py');
    if (exists(source)) return source;
  }
  throw new Error('Sweetiebot background-commit worker is missing. Repair the Sweetiebot extension and retry this saved pony profile.');
}

// The detached worker owns Git serialization, durable publication receipts,
// exponential retry and recovery after the extension host exits.
function createPonyPublishQueue({ enqueue = enqueueBackground, pending = pendingPonyProfiles,
  script } = {}) {
  const resumed = new Map();
  async function publish(directory, pony, storedPath) {
    try {
      const result = await enqueue(script || resolvePonyWorkerScript(), path.resolve(directory),
        { pony, path: storedPath }, '--enqueue-pony');
      return { publication: result, retryScheduled: result.queued === true };
    } catch (error) {
      return { publicationError: error.message };
    }
  }
  function resume(directory) {
    directory = path.resolve(directory);
    if (!resumed.has(directory)) {
      const restore = Promise.resolve().then(() => pending(directory)).then(async entries => {
        for (const entry of entries) {
          const result = await publish(directory, entry.pony, entry.path);
          if (result.publicationError) throw new Error(result.publicationError);
        }
      }).catch(() => { resumed.delete(directory); });
      resumed.set(directory, restore);
    }
    return resumed.get(directory);
  }
  return { enqueue: publish, resume, dispose() { resumed.clear(); } };
}

module.exports = { createPonyPublishQueue, resolvePonyWorkerScript };
