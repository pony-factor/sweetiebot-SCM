'use strict';

const { separateAppsEnabled, getRoleInstallationToken, workflowBotLogin } = require('../github/app-identity');
const MARKER = '<!-- sweetiebot-merge-report -->\n<!-- sweetiebot-generated-summary -->';
const STATUS_MARKER = '<!-- sweetiebot-lindsey-status -->';
const SHA = /^[a-f0-9]{40}$/i;
const MERGE_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

function withinMergeSummaryWindow(pr, now) {
  // Prefer the actual closure time; merged_at is a fallback for incomplete API responses.
  const closedAt = Date.parse(pr.closed_at || pr.merged_at || '');
  return Number.isFinite(closedAt) && closedAt <= now &&
    now - closedAt <= MERGE_SUMMARY_WINDOW_MS;
}

// The opt-in is checked before authentication or network access. Summary
// failures must never turn an independently verified merge into a failure.
async function publishMergeSummaries({ enabled, postStatusUpdates = false, selection, input, result, token,
  fetchImpl = globalThis.fetch, now = Date.now, identity = async () => {
    if (!separateAppsEnabled()) throw Error('Configure the Lindsey GitHub App to publish merge comments.');
    return { token: (await getRoleInstallationToken('lindsey', selection.repository)).token,
      login: workflowBotLogin('lindsey') };
  } }) {
  if (enabled !== true && postStatusUpdates !== true) return [];
  const entries = (result.results || []).filter(item =>
    item.merged === true && item.status === 'merged' ? enabled === true
      : postStatusUpdates === true && ['synced', 'waiting', 'checks_failed'].includes(item.status)
        && SHA.test(item.sha || '') && SHA.test(item.previousHeadSha || '') && item.sha !== item.previousHeadSha);
  if (!entries.length) return [];
  const errors = [];
  let actor, api;
  try {
    actor = await identity();
    api = async (endpoint, method = 'GET', body) => {
      const response = await fetchImpl('https://api.github.com/' + endpoint, {
        method, headers: { Authorization: 'Bearer ' + actor.token, Accept: 'application/vnd.github+json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw Error('GitHub summary request failed (HTTP ' + response.status + ').');
      return response.json();
    };
    actor.login ||= (await api('user')).login;
    if (!actor.login) throw Error('Cannot identify the GitHub summary author.');
  } catch (error) { return entries.map(item => ({ number: item.number, error: error.message })); }
  const prefix = 'repos/' + selection.repository;
  for (const item of entries) {
    try {
      const selected = selection.pullRequests.find(pr => pr.number === item.number);
      const prepared = input.results.find(pr => pr.number === item.number);
      if (!selected || !prepared?.explanation?.trim() || !SHA.test(item.sha || '')) throw Error('No verified summary source.');
      const fresh = await api(prefix + '/pulls/' + item.number);
      const merged = item.merged === true && item.status === 'merged';
      if (!merged && !prepared.decisions?.length && prepared.repairChecks !== true &&
          !prepared.patch && !prepared.resolutionHunks?.length) continue;
      if (fresh.base?.ref !== selected.base || fresh.head?.ref !== selected.head ||
          (merged ? !fresh.merged || fresh.merge_commit_sha !== item.sha
            : fresh.merged || fresh.state !== 'open' || fresh.head?.sha !== item.sha))
        throw Error('GitHub has not confirmed this selected ' + (merged ? 'merge.' : 'prepared head.'));
      if (merged && !withinMergeSummaryWindow(fresh, now())) continue;
      const marker = merged ? MARKER : STATUS_MARKER;
      let existing;
      for (let page = 1; ; page++) {
        const comments = await api(prefix + '/issues/' + item.number + '/comments?per_page=100&page=' + page);
        if (!Array.isArray(comments)) throw Error('Cannot inspect existing summaries.');
        for (const comment of comments) {
          if (comment.user?.login?.toLowerCase() === actor.login.toLowerCase() && comment.body?.startsWith(marker)) existing = comment;
        }
        if (comments.length < 100) break;
        if (page >= 20) throw Error('Existing summary history is incomplete.');
      }
      const body = marker + (merged ? '\n### AI merge summary\n\n' : '\n### Lindsey integration status\n\n') +
        prepared.explanation.trim().slice(0, 4000) + (merged
          ? '\n\nVerified merge into ' + selected.base + ' · commit ' + item.sha.slice(0, 12) + '.'
          : '\n\n' + (item.status === 'checks_failed' ? 'Integrated-head checks failed; PR remains open.'
            : item.status === 'waiting' ? 'Waiting for integrated-head checks; PR remains open.' : 'PR branch prepared; PR remains open.') +
            '\nhttps://github.com/' + selection.repository + '/pull/' + item.number + '/changes/' + item.sha);
      if (existing?.body === body) continue;
      // A long comment-history lookup must not extend the 24-hour posting window.
      if (merged && !withinMergeSummaryWindow(fresh, now())) continue;
      await api(prefix + (existing ? '/issues/comments/' + existing.id : '/issues/' + item.number + '/comments'),
        existing ? 'PATCH' : 'POST', { body });
    } catch (error) { errors.push({ number: item.number, error: error.message }); }
  }
  return errors;
}

module.exports = { publishMergeSummaries, MARKER, STATUS_MARKER };
