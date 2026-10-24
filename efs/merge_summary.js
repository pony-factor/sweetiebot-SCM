'use strict';

const MARKER = '<!-- sweetiebot-merge-summary -->';
const SHA = /^[a-f\d]{40}$/i;
const plain = value => String(value || '').replace(/<!--|-->/g, '').trim();

function integrationSummary(repository, number, expected, result, decisions = []) {
  const reference = sha => SHA.test(sha || '') ? 'https://github.com/' + repository + '/commit/' + sha : '';
  const checks = result.checks;
  const lines = [MARKER, 'Lindsey integration summary for https://github.com/' + repository + '/pull/' + number,
    '', plain(expected.explanation), '',
    result.merged ? 'Merge confirmed.' : result.status === 'ready' ? 'Prepared for merge; the merge request follows these checks.' : result.status === 'synced' ? 'PR branch updated; not merged.' : 'PR remains unmerged.'];
  if (checks) {
    lines.push(checks.hasChecks ? 'GitHub checks on the prepared head: ' + checks.state + '.' : 'No active GitHub checks were reported on the prepared head.');
    for (const check of checks.evidence || []) lines.push('- ' + plain(check.name) + ': ' + plain(check.result));
  } else lines.push('Checks were not evaluated by this synchronization step.');
  if (decisions.length) {
    lines.push('', 'Recorded conflict resolutions:');
    for (const decision of decisions) lines.push('- ' + plain(decision.path) + ': ' + plain(decision.description));
  }
  lines.push('', 'Human decision: no additional decision was requested by the local runner; any user-selected choice is described in the change explanation.');
  const refs = [...new Set([expected.headSha, result.headSha, ...(result.resolutionCommits || []).map(commit => commit.sha), result.sha].map(reference).filter(Boolean))];
  lines.push('', ...refs);
  if (result.reason) lines.push('', plain(result.reason));
  return lines.join('\n');
}

function appendMergeSummary(message, summary) {
  const separator = '\n\n__________\n\n';
  const index = message.indexOf(separator);
  return index < 0 ? message + '\n\n' + summary : message.slice(0, index) + '\n\n' + summary + message.slice(index);
}

async function publishIntegrationSummary(api, repository, number, headSha, result, body) {
  const root = 'repos/' + repository;
  const user = await api('user');
  if (!user?.login) throw Error('Cannot verify summary comment ownership.');
  let existing;
  for (let page = 1; page <= 20; page++) {
    const comments = await api(root + '/issues/' + number + '/comments?per_page=100&page=' + page);
    if (!Array.isArray(comments)) throw Error('Cannot inspect existing integration summaries.');
    existing ||= comments.find(comment => comment.user?.login === user.login && comment.body?.startsWith(MARKER));
    if (comments.length < 100) break;
    if (page === 20) throw Error('Integration summary history is incomplete.');
  }
  const fresh = await api(root + '/pulls/' + number);
  if (fresh.head?.sha !== headSha || (result.merged ? !fresh.merged || fresh.merge_commit_sha !== result.sha : fresh.state !== 'open')) {
    throw Error('PR changed before publishing its integration summary.');
  }
  if (existing?.body === body) return;
  await api(existing ? root + '/issues/comments/' + existing.id : root + '/issues/' + number + '/comments',
    existing ? 'PATCH' : 'POST', ['-f', 'body=' + body]);
}

module.exports = { integrationSummary, appendMergeSummary, publishIntegrationSummary };
