'use strict';
const { githubApi } = require('./merge_pull_request');
const { safePatchPath } = require('./merge_patch');
const MARKER = '<!-- sweetiebot-merge-review -->';

function blockerReport(pr, reason, paths, explanation = '') {
  const options = [
    { id: 'preserve-both', suggested: true, reaction: '+1', label: 'Keep current main and add the PR features', recommended: true,
      description: 'Retry the integration while retaining both sets of intended behavior.',
      prompt: 'Inspect the current common ancestor, main, PR changes and local failure. Preserve all existing main behavior and add the intended PR features. Rebuild a valid resolution for the overlapping files, retain nonconflicting files, and synchronize only this PR branch with the local handoff. Do not merge, rebase or rewrite history.' },
    { id: 'review-first', suggested: true, reaction: 'heart', label: 'Review the resolution before applying it',
      description: 'Show the competing edits and proposed per-file decisions first.',
      prompt: 'Inspect this PR conflict and the local executor failure. Explain the competing edits and propose a complete per-file resolution with concrete tradeoffs. Do not change any files, branches or PR state. Post the proposed decisions in this existing inline thread for review.' }
  ];
  return { options, text: '### Automatic integration stopped\n\n' + reason +
    '\n\nOverlapping files: ' + paths.map(path => '`' + path + '`').join(', ') + '.' +
    (explanation ? '\n\n' + explanation : '') +
    '\n\n**Recommended: preserve current main and add the PR features.** A textual overlap alone is not proof that a product decision is ambiguous. The local execution failed; no successful merge is being claimed.\n\n' +
    '👍 **Keep both intentions:** inspect the failure and retry a branch-only resolution.\n\n' +
    '❤️ **Review first:** explain the competing edits and per-file choices without applying them.\n\n' +
    'React with exactly one listed emoji to select that path, or use the matching Lindsey button. These choices do not authorize merging or history rewriting.' };
}

function firstDiffAnchor(patch) {
  let left, right;
  for (const line of String(patch || '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); continue; }
    if (right === undefined || line.startsWith('\\')) continue;
    if (line.startsWith('+')) return { line: right, side: 'RIGHT' };
    if (line.startsWith('-')) return { line: left, side: 'LEFT' };
    if (line.startsWith(' ')) { left++; right++; }
  }
  return null;
}

async function publishBlockerReport({ repository, pr, reason, paths, explanation, api = githubApi }) {
  paths = [...new Set(paths || [])].filter(safePatchPath);
  const report = blockerReport(pr, reason, paths, explanation);
  const prefix = 'repos/' + repository;
  try {
    const actor = await api('user');
    const fresh = await api(prefix + '/pulls/' + pr.number);
    if (fresh.state !== 'open' || fresh.head?.sha !== pr.headSha || fresh.base?.ref !== pr.base || fresh.head?.ref !== pr.head || (pr.title && fresh.title !== pr.title)) {
      throw Error('The selected PR changed; refresh before posting resolution choices.');
    }
    const base = await api(prefix + '/branches/' + encodeURIComponent(pr.base));
    if (!/^[a-f0-9]{40}$/i.test(base.commit?.sha || '')) throw Error('Cannot verify the current base.');
    const files = [];
    for (let page = 1; page <= 3; page++) {
      const next = await api(prefix + '/pulls/' + pr.number + '/files?per_page=100&page=' + page);
      files.push(...next); if (next.length < 100) break;
    }
    const file = files.find(file => paths.includes(file.filename) && firstDiffAnchor(file.patch));
    if (!file) throw Error('The overlapping code cannot be anchored in the current PR diff. Local choices remain available.');
    const body = MARKER + '\n' + report.text + '\n\n<!-- sweetiebot-merge-options\n' +
      JSON.stringify({ version: 1, headSha: pr.headSha, baseSha: base.commit.sha, options: report.options }) + '\n-->';
    let existing;
    for (let page = 1; page <= 20; page++) {
      const comments = await api(prefix + '/pulls/' + pr.number + '/comments?per_page=100&page=' + page);
      existing = comments.find(comment => comment.path === file.filename && comment.body?.startsWith(MARKER) && comment.user?.login === actor.login) || existing;
      if (comments.length < 100) break;
      if (page === 20) throw Error('Existing review history is incomplete.');
    }
    const latest = await api(prefix + '/pulls/' + pr.number);
    const latestBase = await api(prefix + '/branches/' + encodeURIComponent(pr.base));
    if (latest.state !== 'open' || latest.head?.sha !== pr.headSha || latest.base?.ref !== pr.base || latestBase.commit?.sha !== base.commit.sha) {
      throw Error('The PR or base advanced before posting the choices; refresh and retry.');
    }
    const posted = await api(prefix + '/pulls/' + pr.number + '/comments' + (existing ? '/' + existing.id : ''), {
      method: existing ? 'PATCH' : 'POST', body: existing ? { body } : {
        body, commit_id: pr.headSha, path: file.filename, ...firstDiffAnchor(file.patch)
      }
    });
    return { ...report, body, url: posted.html_url, posted: true };
  } catch (error) { return { ...report, posted: false, error: error.message }; }
}
module.exports = { blockerReport, firstDiffAnchor, publishBlockerReport };
