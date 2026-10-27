'use strict';

const SHA = /^[a-f0-9]{40}$/i;

// The local merge coordinator must explicitly defer an actual CI failure before
// Lindsey opens an independent repair. Old timeline entries are not authority.
function deferredCiRepairCandidate(state, pr) {
  if (!state || state.rateLimit || !Array.isArray(state.deferred) ||
      !Array.isArray(state.history) || !Array.isArray(state.pullRequests) ||
      !state.deferred.some(item => item?.number === pr?.number &&
        (!item.kind || item.kind === 'failed_checks'))) return null;
  const latest = state.history.filter(item => item?.number === pr.number).at(-1);
  const current = state.pullRequests.find(item => item?.number === pr.number);
  if (latest?.status !== 'checks_failed' || !current ||
      current.head !== pr.head || current.base !== pr.base ||
      !SHA.test(current.headSha || '') || !SHA.test(current.baseSha || '')) return null;
  return { number: pr.number, head: current.head, headSha: current.headSha,
    base: current.base, baseSha: current.baseSha };
}

module.exports = { deferredCiRepairCandidate };
