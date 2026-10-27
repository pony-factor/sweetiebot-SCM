'use strict';

// Browser-based Lindsey work does not emit Codex turn notifications.
function createMergeKeepAwake({ platform = process.platform, pid = process.pid,
  spawn = require('node:child_process').spawn, schedule = setTimeout, cancel = clearTimeout,
  now = Date.now, idleMs = 30 * 60 * 1000 } = {}) {
  let child, timer, disposed = false, active = false;
  let lastProgress = 0, progressKey;
  function stop() {
    cancel(timer);
    timer = undefined;
    const previous = child;
    child = undefined;
    previous?.kill();
  }
  function refresh() {
    if (disposed || !active || platform !== 'darwin' || now() - lastProgress >= idleMs) { stop(); return; }
    if (child) return;
    cancel(timer);
    try {
      const spawned = spawn('/usr/bin/caffeinate', ['-d', '-i', '-u', '-t', '30', '-w', String(pid)], { stdio: 'ignore' });
      child = spawned;
      spawned.on('error', () => { if (child === spawned) child = undefined; });
      spawned.on('exit', () => { if (child === spawned) child = undefined; });
    } catch { /* Retry on the next renewal without breaking the merge queue. */ }
    timer = schedule(() => { stop(); refresh(); }, 20000);
    timer?.unref?.();
  }
  return {
    update(state, selection, enabled = true) {
      const settled = new Set([...(state.merged || []), ...(state.deferred || [])].map(item => item.number));
      const key = JSON.stringify([state.round, [...settled], state.history?.length,
        state.workers?.map(worker => [worker.id, worker.phase, worker.merged])]);
      if (key !== progressKey) { progressKey = key; lastProgress = now(); }
      active = enabled && !state.rateLimit && selection.pullRequests.some(pr => !settled.has(pr.number));
      refresh();
    },
    dispose() { disposed = true; active = false; stop(); }
  };
}

module.exports = { createMergeKeepAwake };
