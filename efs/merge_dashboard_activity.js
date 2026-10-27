'use strict';

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

function renderMergeActivitySummary(parent, number, presentation) {
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
  title.textContent = (presentation.sha ? ' ' : '') + presentation.summary;
  parent.appendChild(title);
}

if (typeof module === 'object' && module.exports) {
  module.exports = { mergeActivityPresentation, renderMergeActivitySummary };
}
