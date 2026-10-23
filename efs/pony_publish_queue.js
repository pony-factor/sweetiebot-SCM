'use strict';

const path = require('node:path');
const { publishPonyProfile, pendingPonyProfiles } = require('./pony_git_publish');

// All retries share the same serial queue as first attempts. A failed push must
// finish before another job can inspect main or create a commit.
function createPonyPublishQueue({ publish = publishPonyProfile, pending = pendingPonyProfiles,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let tail = Promise.resolve();
  const jobs = new Map();
  const resumed = new Map();
  function attempt(job) {
    job.timer = undefined;
    job.promise = tail.then(async () => {
      try {
        const publication = await publish(job.directory, job.pony, job.storedPath);
        jobs.delete(job.key);
        return { publication };
      } catch (error) {
        const delay = Math.min(15000 * 2 ** Math.min(job.failures++, 5), 300000);
        job.timer = schedule(() => { void attempt(job); }, delay);
        job.timer.unref?.();
        return { publicationError: error.message, retryScheduled: true };
      }
    });
    tail = job.promise.then(() => {}, () => {});
    return job.promise;
  }
  function enqueue(directory, pony, storedPath) {
    directory = path.resolve(directory);
    const key = directory + '\0' + storedPath;
    const existing = jobs.get(key);
    if (existing) return existing.promise;
    const job = { key, directory, pony, storedPath, failures: 0 };
    jobs.set(key, job);
    return attempt(job);
  }
  function resume(directory) {
    directory = path.resolve(directory);
    if (!resumed.has(directory)) {
      const restore = Promise.resolve().then(() => pending(directory)).then(entries => {
        for (const entry of entries) void enqueue(directory, entry.pony, entry.path);
      }).catch(() => {
        // Retry discovery on the next cache operation if the repository was unavailable.
        resumed.delete(directory);
      });
      resumed.set(directory, restore);
    }
    return resumed.get(directory);
  }
  function dispose() {
    for (const job of jobs.values()) if (job.timer) cancel(job.timer);
    jobs.clear();
  }
  return { enqueue, resume, dispose };
}

module.exports = { createPonyPublishQueue };
