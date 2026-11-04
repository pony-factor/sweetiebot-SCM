'use strict';

// Render activity timestamps using the viewer's local timezone.
function formatTimelineTimestamp(at, mode, nowMs = Date.now()) {
  if (mode !== 'relative' && mode !== 'clock') return '';
  const time = new Date(at);
  const atMs = time.getTime();
  if (!Number.isFinite(atMs)) return '';
  if (mode === 'clock') {
    const now = new Date(nowMs);
    const today = now.getFullYear() === time.getFullYear() &&
      now.getMonth() === time.getMonth() && now.getDate() === time.getDate();
    return today ? time.toLocaleTimeString() : time.toLocaleString();
  }
  const seconds = Math.round((nowMs - atMs) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  const units = [
    [31536000, 'y'], [2592000, 'mo'], [604800, 'w'],
    [86400, 'd'], [3600, 'h'], [60, 'm']
  ];
  const [duration, label] = units.find(([size]) => abs >= size);
  const value = Math.floor(abs / duration) + label;
  return seconds >= 0 ? value + ' ago' : 'in ' + value;
}
// Use the activity timeline's preference for GitHub-confirmed merge results too.
function formatMergeOutcome(mergedAt, mergeCommit, mode, nowMs = Date.now()) {
  const timestamp = formatTimelineTimestamp(mergedAt, mode, nowMs);
  const suffix = timestamp ? (mode === 'clock' ? ' at ' : ' ') + timestamp : '';
  return 'GitHub merged this PR' + suffix +
    (mergeCommit ? '\nSquash/merge commit: ' + mergeCommit : '');
}
if (typeof module === 'object' && module.exports) {
  module.exports = { formatTimelineTimestamp, formatMergeOutcome };
}
