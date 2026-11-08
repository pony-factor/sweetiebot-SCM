'use strict';

const SHA = /^[a-f0-9]{40}$/i;

// A deferred merge may stop before its executor can report checks_failed.
// Current-head GitHub failures can still start a fresh repair; the launcher
// independently rechecks the PR identity and CI before opening it.
function deferredCiRepairCandidate(state, pr) {
  if (!state || state.rateLimit || !Array.isArray(state.deferred) ||
      !Array.isArray(state.history) || !Array.isArray(state.pullRequests) ||
      !state.deferred.some(item => item?.number === pr?.number &&
        (!item.kind || item.kind === 'failed_checks' || item.kind === 'capability'))) return null;
  const latest = state.history.filter(item => item?.number === pr.number).at(-1);
  const current = state.pullRequests.find(item => item?.number === pr.number);
  const stoppedWithFailingCi = latest?.status === 'blocked' && pr.state === 'checks' &&
    pr.currentHead === current?.headSha;
  if ((latest?.status !== 'checks_failed' && !stoppedWithFailingCi) || !current ||
      current.head !== pr.head || current.base !== pr.base ||
      !SHA.test(current.headSha || '') || !SHA.test(current.baseSha || '')) return null;
  return { number: pr.number, head: current.head, headSha: current.headSha,
    base: current.base, baseSha: current.baseSha };
}

module.exports = { deferredCiRepairCandidate };
