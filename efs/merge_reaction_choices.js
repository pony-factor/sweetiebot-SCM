'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseReportOptions } = require('./merge_blocker_actions');

function decisionOptions(comment, pr, actor) {
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
  return options;
}

function reactionDecision(comment, pr, reactions, actor) {
  const options = decisionOptions(comment, pr, actor);
  if (!options) return null;
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
  async function request(endpoint, method = 'GET', body) {
    const response = await fetchImpl('https://api.github.com' + endpoint, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: {
      'Content-Type': 'application/json', Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    } });
    if (!response.ok) {
      throw await require('./github_rate_limit').githubResponseError(response, 'GitHub reaction lookup failed (HTTP ' + response.status + ').');
    }
    return response.status === 204 ? null : response.json();
  }
  const get = endpoint => request(endpoint);
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
  return {
    async select(pr, comment, option) {
      actor ||= await get('/user');
      const endpoint = '/repos/' + repository + '/pulls/comments/' + comment.id;
      const fresh = await get(endpoint);
      if (fresh.body !== comment.body || fresh.updated_at !== comment.updated_at) throw Error('The code choices changed. Refresh before choosing.');
      const options = decisionOptions(fresh, pr, actor);
      const selected = options?.find(candidate => candidate.id === (option.sourceId || option.id) && candidate.prompt === option.prompt && candidate.reaction === option.reaction);
      if (!selected) throw Error('This choice is not bound to the current PR head and base.');
      const votes = await reactions(comment.id);
      // A button selects one choice: remove this user's competing or stale votes.
      // Never touch anyone else's reactions or unrelated reaction types.
      for (const vote of votes) {
        if (vote.user?.id !== actor.id || !options.some(item => item.reaction === vote.content)) continue;
        if (vote.content === selected.reaction && Date.parse(vote.created_at) > Date.parse(fresh.updated_at)) continue;
        await request(endpoint + '/reactions/' + vote.id, 'DELETE');
      }
      const vote = await request(endpoint + '/reactions', 'POST', { content: selected.reaction });
      if (vote.user?.id !== actor.id || vote.user?.type !== 'User') throw Error('GitHub did not confirm the reaction as your signed-in user.');
      return vote;
    },
    async inspect(pr, comments, engine = 'web') {
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
      await launch(pr, fresh, checked.option, engine);
      return;
    }
  } };
}

module.exports = { reactionDecision, createReactionChoices };
