'use strict';

function mergeActivityOrigin(event) {
  const location = ['local', 'upstream', 'review'].includes(event?.location) ? event.location
    : event?.state === 'progress' || event?.state === 'action' ? 'local' : 'upstream';
  return { location, label: location === 'upstream' ? 'Upstream · GitHub' : location === 'review' ? 'AI review' : 'Local',
    icon: location === 'upstream' ? '↗' : location === 'review' ? '✦' : '▣' };
}

function renderMergeActivityOrigin(parent, event) {
  const origin = mergeActivityOrigin(event), document = parent.ownerDocument;
  const badge = document.createElement('span');
  badge.className = 'activity-origin ' + origin.location;
  badge.title = origin.label;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true'); icon.textContent = origin.icon;
  badge.appendChild(icon);
  const label = document.createElement('span'); label.textContent = origin.label;
  badge.appendChild(label); parent.appendChild(badge);
}

function mergeActivityElapsed(activity, now = Date.now()) {
  const start = Date.parse(activity?.at), updated = Date.parse(activity?.updatedAt);
  if (!Number.isFinite(start)) return '';
  const duration = ms => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's';
  };
  return duration(now - start) + ' in this step' + (Number.isFinite(updated)
    ? ' · last update ' + duration(now - updated) + ' ago' : '')
    + (activity.nextPollAt > now ? ' · next GitHub check in ' + Math.ceil((activity.nextPollAt - now) / 1000) + 's' : '');
}

function mergeActivityPresentation(event, prs = []) {
  const message = String(event?.message || '').trim();
  const details = String(event?.details || '');
  const oldHash = details.match(/(?:^|\s+·\s+)(?:Pushed )?Commit:\s*([a-f0-9]{7,64})\b/i)?.[1] || '';
  const candidate = String(event?.commitSha || oldHash);
  const safeHash = /^[a-f0-9]{7,64}$/i.test(candidate) ? candidate : '';
  const commits = prs.find(item => item.number === event?.number)?.commits || [];
  const matches = commits.filter(item => safeHash && typeof item.sha === 'string' && item.sha.toLowerCase().startsWith(safeHash.toLowerCase()));
  const gitCommit = matches.length === 1 ? matches[0] : null;
  const sha = gitCommit?.sha || safeHash;
  const title = (String(gitCommit?.commit?.message || '').split('\n')[0].trim() ||
    String(event?.commitTitle || '').split('\n')[0].trim()).slice(0, 160);
  const fetchFailure = event?.state === 'error' && /^(?:fetch failed|GitHub (?:request|refresh) failed)/i.test(message);
  const explanation = details.split('\n').map(line =>
    line.replace(/(?:^|\s+·\s+)(?:Pushed )?Commit:\s*[a-f0-9]{7,64}\b/i, '').trim()
  ).filter(Boolean).join('\n') || (fetchFailure ? /^fetch failed\.?$/i.test(message)
    ? 'No request details were captured for this earlier error. Use Refresh GitHub status to retry with diagnostics.'
    : message : '');
  const operational = event?.state === 'progress';
  const summary = (operational ? message : title) || (fetchFailure ? 'Fetch failed' : message) || (sha ? 'Commit' : 'Activity');
  const status = sha && title && message !== title ? operational ? title : message : '';
  return { sha, shortSha: sha.slice(0, 7), summary, status, explanation,
    expandable: Boolean(status || explanation) };
}

function renderMergeActivitySummary(parent, number, presentation, linkConversationComment = false) {
  const document = parent.ownerDocument;
  const pr = document.createElement('span');
  pr.className = 'event-pr-number';
  pr.textContent = '#' + number + ' ';
  parent.appendChild(pr);
  if (presentation.sha) {
    const code = document.createElement('code');
    code.className = 'event-commit-sha';
    code.textContent = presentation.shortSha;
    parent.appendChild(code);
  }
  const title = document.createElement('span');
  title.className = 'event-summary-title';
  if (linkConversationComment && !presentation.sha &&
      presentation.summary === 'PR conversation comment posted') {
    const prefix = document.createElement('span');
    prefix.textContent = 'PR ';
    title.appendChild(prefix);
    const link = document.createElement('a');
    link.className = 'event-link';
    link.textContent = 'conversation comment';
    title.appendChild(link);
    const suffix = document.createElement('span');
    suffix.textContent = ' posted';
    title.appendChild(suffix);
    parent.appendChild(title);
    return link;
  }
  title.textContent = (presentation.sha ? ' ' : '') + presentation.summary;
  parent.appendChild(title);
  return null;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { mergeActivityPresentation, renderMergeActivitySummary,
    mergeActivityOrigin, renderMergeActivityOrigin, mergeActivityElapsed };
}
