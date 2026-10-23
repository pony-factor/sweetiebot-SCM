'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseReportOptions } = require('./merge_blocker_actions');

function reactionDecision(comment, pr, reactions, actor) {
  if (!/^[a-f0-9]{40}$/i.test(pr.headSha || '') || !/^[a-f0-9]{40}$/i.test(pr.baseSha || '')) return null;
  if (!comment?.body?.includes('<!-- sweetiebot-merge-review -->') ||
      !Number.isSafeInteger(comment.id) || !comment.path || !comment.line ||
      comment.in_reply_to_id || !['LEFT', 'RIGHT'].includes(comment.side) ||
      comment.commit_id !== pr.headSha || !actor?.id || actor.type !== 'User') return null;
  const blocks = [...comment.body.matchAll(/<!--\s*sweetiebot-merge-options\s*\n([\s\S]*?)\n\s*-->/g)];
  if (blocks.length !== 1 || blocks[0][1].length > 16000) return null;
  let data;
  try { data = JSON.parse(blocks[0][1]); } catch { return null; }
  if (data.headSha !== pr.headSha || data.baseSha !== pr.baseSha) return null;
  const options = parseReportOptions(comment.body);
  if (options.length < 2 || options.length > 3 || options.some(option => !option.reaction) ||
      new Set(options.map(option => option.reaction)).size !== options.length) return null;
  const updated = Date.parse(comment.updated_at);
  if (!Number.isFinite(updated)) return null;
  const votes = reactions.filter(reaction => reaction.user?.id === actor.id &&
    reaction.user?.type === 'User' && options.some(option => option.reaction === reaction.content));
  // Multiple choices are ambiguous. Never interpret the latest as an override.
  if (votes.length !== 1 || !Number.isSafeInteger(votes[0].id) ||
      !(Date.parse(votes[0].created_at) > updated)) return null;
  return { option: options.find(option => option.reaction === votes[0].content), reaction: votes[0] };
}

function createReactionChoices({ repository, token, fetchImpl, storageDirectory, launch }) {
  let actor;
  async function get(endpoint) {
    const response = await fetchImpl('https://api.github.com' + endpoint, { headers: {
      Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    } });
    if (!response.ok) {
      const error = Error('GitHub reaction lookup failed (HTTP ' + response.status + ').');
      error.rateLimited = response.status === 403 || response.status === 429;
      throw error;
    }
    return response.json();
  }
  async function reactions(id) {
    const result = [];
    for (let page = 1; page <= 3; page++) {
      const chunk = await get('/repos/' + repository + '/pulls/comments/' + id + '/reactions?per_page=100&page=' + page);
      if (!Array.isArray(chunk)) throw Error('GitHub returned invalid reactions.');
      result.push(...chunk);
      if (chunk.length < 100) return result;
    }
    // A truncated list cannot establish that the user chose exactly one option.
    return [];
  }
  return { async inspect(pr, comments) {
    if (!storageDirectory || ['merged', 'closed'].includes(pr.state)) return;
    for (const comment of comments) {
      if (!comment.body?.includes('<!-- sweetiebot-merge-review -->') ||
          !Number.isSafeInteger(comment.id) || comment.commit_id !== pr.headSha) continue;
      actor ||= await get('/user');
      const decision = reactionDecision(comment, pr, await reactions(comment.id), actor);
      if (!decision) continue;
      // Re-read both the comment and its reactions immediately before claiming.
      const fresh = await get('/repos/' + repository + '/pulls/comments/' + comment.id);
      if (fresh.body !== comment.body || fresh.updated_at !== comment.updated_at) continue;
      const checked = reactionDecision(fresh, pr, await reactions(comment.id), actor);
      if (!checked || checked.reaction.id !== decision.reaction.id) continue;
      const key = createHash('sha256').update(repository + ':' + comment.id + ':' + decision.reaction.id).digest('hex');
      const directory = path.join(storageDirectory, 'merge-reaction-claims');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try { await fs.writeFile(path.join(directory, key), '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      // Claim before dispatch: reopening windows or an uncertain launch failure
      // must never replay a code-changing task. A new reaction can retry.
      await launch(pr, fresh, checked.option);
      return;
    }
  } };
}

module.exports = { reactionDecision, createReactionChoices };
