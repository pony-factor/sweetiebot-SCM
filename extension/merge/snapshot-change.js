'use strict';

// Legacy web handoffs describe head drift as a capability failure. It is
// recoverable only after the coordinator verifies the new PR identity and
// linear ancestry; the old patch is never reused. Human decisions stay blocked.
function isSnapshotDeferral(item) {
  if (!item || item.kind === 'human_review') return false;
  if (item.kind === 'snapshot_changed') return true;
  if (item.kind && item.kind !== 'capability') return false;
  return /(?:the )?selected PR (?:head changed externally|head, base or title changed|changed outside this batch|changed while its parallel review)/i
    .test(String(item.reason || ''));
}

module.exports = { isSnapshotDeferral };
