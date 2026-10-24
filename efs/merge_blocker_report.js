'use strict';
const { githubApi } = require('./merge_pull_request');
const { safePatchPath } = require('./merge_patch');
const MARKER = '<!-- sweetiebot-merge-analysis -->';
const REVIEW_GROUP = '<!-- sweetiebot-merge-analysis-review -->';
const LEGACY_MARKER = '<!-- sweetiebot-merge-review -->';

function blockerReport(pr, reason, paths, explanation = '', decisions = []) {
  const allowed = new Set((paths || []).filter(safePatchPath));
  const seen = new Set();
  const notes = (decisions || []).filter(note => allowed.has(note?.path) &&
    typeof note.title === 'string' && note.title.trim() &&
    typeof note.description === 'string' && note.description.trim() && !seen.has(note.path) && seen.add(note.path))
    .map(note => ({ path: note.path, title: note.title.trim().slice(0, 160), description: note.description.trim().slice(0, 4000) }));
  return { options: [], notes, text: notes.map(note => '### ' + note.title + '\n\n' + note.description).join('\n\n') || explanation || reason };
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

async function publishBlockerReport({ repository, pr, reason, paths, explanation, decisions = [], summary, api = githubApi }) {
  paths = [...new Set(paths || [])].filter(safePatchPath);
  const report = blockerReport(pr, reason, paths, explanation, decisions);
  // A filename or executor failure cannot establish the competing code intentions.
  // The reviewer must supply substantive analysis before an inline note is posted.
  if (!report.notes.length) return { ...report, posted: false };
  const prefix = 'repos/' + repository;
  const postedNotes = [];
  try {
    const actor = await api('user');
    const matches = fresh => fresh.state === 'open' && fresh.head?.sha === pr.headSha &&
      fresh.head?.ref === pr.head && fresh.base?.ref === pr.base && (!pr.title || fresh.title === pr.title);
    if (!matches(await api(prefix + '/pulls/' + pr.number))) throw Error('The selected PR changed; refresh the code analysis.');
    const base = await api(prefix + '/branches/' + encodeURIComponent(pr.base));
    if (!/^[a-f0-9]{40}$/i.test(base.commit?.sha || '')) throw Error('Cannot verify the current base.');
    const files = [], comments = [];
    for (let page = 1; page <= 30; page++) {
      const next = await api(prefix + '/pulls/' + pr.number + '/files?per_page=100&page=' + page);
      files.push(...next); if (next.length < 100) break;
      if (page === 30) throw Error('Current PR file list is incomplete.');
    }
    for (let page = 1; page <= 20; page++) {
      const next = await api(prefix + '/pulls/' + pr.number + '/comments?per_page=100&page=' + page);
      comments.push(...next); if (next.length < 100) break;
      if (page === 20) throw Error('Existing review history is incomplete.');
    }
    const anchors = report.notes.map(note => {
      const anchor = firstDiffAnchor(files.find(file => file.filename === note.path)?.patch);
      if (!anchor) throw Error('Cannot anchor the analysis for ' + note.path + ' in the current diff.');
      return { ...note, anchor, body: MARKER + '\n### ' + note.title + '\n\n' + note.description };
    });
    const owned = comments.filter(comment => comment.user?.login === actor.login &&
      (comment.body?.startsWith(MARKER) || (comment.body?.startsWith(LEGACY_MARKER) && /### Automatic integration stopped/.test(comment.body))));
    const reviews = [];
    for (let page = 1; page <= 20; page++) {
      const next = await api(prefix + '/pulls/' + pr.number + '/reviews?per_page=100&page=' + page);
      reviews.push(...next); if (next.length < 100) break;
      if (page === 20) throw Error('Existing review list is incomplete.');
    }
    const existingReview = [...reviews].reverse().find(review => review.user?.login === actor.login &&
      review.body?.startsWith(REVIEW_GROUP) && review.commit_id === pr.headSha &&
      anchors.every(note => owned.some(comment => comment.pull_request_review_id === review.id && comment.path === note.path)));
    const latest = await api(prefix + '/pulls/' + pr.number);
    const latestBase = await api(prefix + '/branches/' + encodeURIComponent(pr.base));
    if (!matches(latest) || latestBase.commit?.sha !== base.commit.sha) throw Error('The PR or base advanced; refresh the code analysis.');
    const reviewBody = REVIEW_GROUP + '\n' + (summary || 'Integrate ' + pr.title + ' with current ' + pr.base + '. The inline notes explain the competing edits and combined behavior for each affected file.');
    let review;
    if (existingReview) {
      review = await api(prefix + '/pulls/' + pr.number + '/reviews/' + existingReview.id, {method:'PUT', body:{body:reviewBody}});
      for (const note of anchors) {
        const existing = owned.find(comment => comment.pull_request_review_id === existingReview.id && comment.path === note.path);
        const posted = await api(prefix + '/pulls/comments/' + existing.id, {method:'PATCH',body:{body:note.body}});
        postedNotes.push({...note,url:posted.html_url});
      }
    } else {
      review = await api(prefix + '/pulls/' + pr.number + '/reviews', {method:'POST',body:{
        commit_id:pr.headSha,event:'COMMENT',body:reviewBody,
        comments:anchors.map(note=>({path:note.path,...note.anchor,body:note.body}))
      }});
      for (const note of anchors) postedNotes.push({...note,url:review.html_url});
      // Migrate only our unused generated notes. Preserve threads with any user
      // replies or reactions; those discussions must not be discarded.
      for (const old of owned) {
        if (!anchors.some(note=>note.path===old.path) || old.reactions?.total_count !== 0 ||
            comments.some(comment=>comment.in_reply_to_id===old.id)) continue;
        await api(prefix + '/pulls/comments/' + old.id, {method:'DELETE'});
      }
    }
    return { ...report, posted: true, reviewUrl: review.html_url, comments: postedNotes };
  } catch (error) { return { ...report, posted: false, comments: postedNotes, error: error.message, ...(error.rateLimited ? { rateLimited: true, retryAt: error.retryAt } : {}) }; }
}
module.exports = { blockerReport, firstDiffAnchor, publishBlockerReport };
