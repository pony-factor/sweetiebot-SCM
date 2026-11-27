'use strict';

const SHA = /^[a-f0-9]{40}$/i;

// The coordinator can defer a failing selected head during review or after
// local execution. The dashboard verifies the failure on GitHub before launch.
function deferredCiRepairCandidate(state, pr) {
  if (!state || state.rateLimit || !Array.isArray(state.deferred) ||
      !Array.isArray(state.history) || !Array.isArray(state.pullRequests)) return null;
  const deferred = state.deferred.find(item => item?.number === pr?.number);
  if (!deferred || (deferred.kind && deferred.kind !== 'failed_checks')) return null;
  const current = state.pullRequests.find(item => item?.number === pr.number);
  if (!current ||
      current.head !== pr.head || current.base !== pr.base ||
      !SHA.test(current.headSha || '') || !SHA.test(current.baseSha || '')) return null;
  if (deferred.headSha !== undefined) {
    if (deferred.kind !== 'failed_checks' || deferred.headSha !== current.headSha) return null;
  } else if (state.history.findLast(item => item?.number === pr.number)?.status !== 'checks_failed') {
    return null;
  }
  return { number: pr.number, head: current.head, headSha: current.headSha,
    base: current.base, baseSha: current.baseSha };
}

function deferredConflictRepairCandidate(state, pr) {
  if (!state || state.rateLimit || !Array.isArray(state.deferred) ||
      !Array.isArray(state.history) || !Array.isArray(state.pullRequests) ||
      !state.deferred.some(item => item?.number === pr?.number &&
        (!item.kind || item.kind === 'conflict'))) return null;
  const latest = state.history.filter(item => item?.number === pr.number).at(-1);
  const current = state.pullRequests.find(item => item?.number === pr.number);
  if (latest?.status !== 'needs_resolution' || !latest.conflictPaths?.length || !current ||
      current.head !== pr.head || current.base !== pr.base ||
      !SHA.test(current.headSha || '') || !SHA.test(current.baseSha || '')) return null;
  return { number: pr.number, head: current.head, headSha: current.headSha,
    base: current.base, baseSha: current.baseSha };
}

module.exports = { deferredCiRepairCandidate, deferredConflictRepairCandidate };
