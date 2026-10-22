'use strict';

const path = require('node:path');
const { enqueue: enqueueBackground } = require('./background_commit');
const { pendingPonyProfiles } = require('./pony_git_publish');

// VS Code only hands off durable jobs. The shared detached worker owns retries,
// repository locking, and waiting for existing commit/title/push jobs.
function createPonyPublishQueue({ enqueue = enqueueBackground, pending = pendingPonyProfiles,
  script = path.join(__dirname, 'background_commit.py') } = {}) {
  const resumed = new Map();
  async function publish(directory, pony, storedPath) {
    try {
      const result = await enqueue(script, path.resolve(directory),
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
  return { enqueue: publish, resume };
}

module.exports = { createPonyPublishQueue };
