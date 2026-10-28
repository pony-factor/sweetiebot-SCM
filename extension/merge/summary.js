'use strict';

const { separateAppsEnabled, getRoleInstallationToken, workflowBotLogin } = require('../github/app_identity');
const MARKER = '<!-- sweetiebot-merge-report -->\n<!-- sweetiebot-generated-summary -->';
const SHA = /^[a-f0-9]{40}$/i;

// The opt-in is checked before authentication or network access. Summary
// failures must never turn an independently verified merge into a failure.
async function publishMergeSummaries({ enabled, selection, input, result, token,
  fetchImpl = globalThis.fetch, identity = async () => {
    if (!separateAppsEnabled()) return { token };
    return { token: (await getRoleInstallationToken('lindsey', selection.repository)).token,
      login: workflowBotLogin('lindsey') };
  } }) {
  if (enabled !== true) return [];
  const entries = (result.results || []).filter(item => item.merged === true && item.status === 'merged');
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
      if (!fresh.merged || fresh.merge_commit_sha !== item.sha || fresh.base?.ref !== selected.base ||
          fresh.head?.ref !== selected.head) throw Error('GitHub has not confirmed this selected merge.');
      let existing;
      for (let page = 1; ; page++) {
        const comments = await api(prefix + '/issues/' + item.number + '/comments?per_page=100&page=' + page);
        if (!Array.isArray(comments)) throw Error('Cannot inspect existing summaries.');
        for (const comment of comments) {
          if (comment.user?.login?.toLowerCase() === actor.login.toLowerCase() && comment.body?.startsWith(MARKER)) existing = comment;
        }
        if (comments.length < 100) break;
        if (page >= 20) throw Error('Existing summary history is incomplete.');
      }
      const body = MARKER + '\n### AI merge summary\n\n' + prepared.explanation.trim().slice(0, 4000) +
        '\n\nVerified merge into ' + selected.base + ' · commit ' + item.sha.slice(0, 12) + '.';
      if (existing?.body === body) continue;
      await api(prefix + (existing ? '/issues/comments/' + existing.id : '/issues/' + item.number + '/comments'),
        existing ? 'PATCH' : 'POST', { body });
    } catch (error) { errors.push({ number: item.number, error: error.message }); }
  }
  return errors;
}

module.exports = { publishMergeSummaries, MARKER };
