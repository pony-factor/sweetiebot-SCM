'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reactionDecision, createReactionChoices } = require('../efs/merge_reaction_choices');
const { reportOptionsInstructions } = require('../efs/merge_blocker_actions');

(async () => {
  const pr = { number: 12, state: 'conflict', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
  const actor = { id: 41, type: 'User' };
  const options = [
    { id: 'adapter', label: 'Keep both APIs', prompt: 'Add an adapter.', reaction: '+1' },
    { id: 'new-api', label: 'Adopt the new API', prompt: 'Update callers.', reaction: 'heart' }
  ];
  const body = choices => '<!-- sweetiebot-merge-review -->\nWhich API?\n' +
    '<!-- sweetiebot-merge-options\n' + JSON.stringify({ version: 1,
      headSha: pr.headSha, baseSha: pr.baseSha, options: choices }) + '\n-->';
  let comment = { id: 90, body: body(options), path: 'src/api.js', line: 4, side: 'RIGHT',
    commit_id: pr.headSha, updated_at: '2026-10-23T12:00:00Z' };
  let votes = [{ id: 100, user: actor, content: '+1', created_at: '2026-10-23T12:01:00Z' }];
  assert.equal(reactionDecision(comment, pr, votes, actor).option.id, 'report-adapter');
  assert.equal(reactionDecision({ ...comment, body: body([options[0]]) }, pr, votes, actor).option.id, 'report-adapter', 'A single substantive implementation action is selectable');
  assert.equal(reactionDecision(comment, pr, [{ ...votes[0], content: 'heart' }], actor).option.id, 'report-new-api');
  assert.equal(reactionDecision(comment, pr, [{ ...votes[0], user: { id: 99, type: 'User' } }], actor), null);
  assert.equal(reactionDecision(comment, pr, votes, { ...actor, type: 'Bot' }), null);
  assert.equal(reactionDecision(comment, pr, [...votes, { ...votes[0], id: 101, content: 'heart' }], actor), null);
  assert.equal(reactionDecision(comment, pr, [{ ...votes[0], created_at: comment.updated_at }], actor), null);
  assert.equal(reactionDecision({ ...comment, commit_id: 'c'.repeat(40) }, pr, votes, actor), null);
  assert.equal(reactionDecision(comment, { ...pr, baseSha: 'c'.repeat(40) }, votes, actor), null);
  assert.equal(reactionDecision({ ...comment, line: null }, pr, votes, actor), null);
  assert.equal(reactionDecision({ ...comment, in_reply_to_id: 12 }, pr, votes, actor), null);
  assert.equal(reactionDecision({ ...comment, body: body(options.map(option => ({ ...option, reaction: '+1' }))) }, pr, votes, actor), null);
  assert(reportOptionsInstructions().includes('👍 (+1), ❤️ (heart), 🚀 (rocket)'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-reactions-'));
  try {
    const launches = [];
    let changed = false;
    const fetchImpl = async address => {
      const url = new URL(address);
      let result;
      if (url.pathname === '/user') result = actor;
      else if (url.pathname.endsWith('/reactions')) result = votes;
      else if (url.pathname.endsWith('/pulls/comments/90')) result = changed
        ? { ...comment, body: body(options.map(option => ({ ...option, prompt: 'Edited instruction' }))) } : comment;
      else throw Error('Unexpected URL: ' + address);
      return { ok: true, json: async () => result };
    };
    const makeRunner = (launch = async (...args) => launches.push(args)) => createReactionChoices({
      repository: 'owner/repo', token: 'test', fetchImpl, storageDirectory: directory, launch });
    changed = true;
    await makeRunner().inspect(pr, [comment]);
    assert.equal(launches.length, 0, 'Edited comments require a fresh choice');
    changed = false;
    await Promise.all([makeRunner().inspect(pr, [comment]), makeRunner().inspect(pr, [comment])]);
    assert.equal(launches.length, 1, 'Atomic claims prevent duplicate launches across windows');
    await makeRunner().inspect(pr, [comment]);
    assert.equal(launches.length, 1, 'Restarting does not replay an existing reaction');
    votes = [{ ...votes[0], id: 102 }];
    await assert.rejects(makeRunner(async () => { throw Error('Launch failed'); }).inspect(pr, [comment]), /Launch failed/);
    await makeRunner().inspect(pr, [comment]);
    assert.equal(launches.length, 1, 'Uncertain launch failures are not replayed');
    votes = [{ ...votes[0], id: 103 }];
    await makeRunner().inspect(pr, [comment]);
    assert.equal(launches.length, 2, 'A fresh reaction can retry');
    await makeRunner().inspect({ ...pr, state: 'merged' }, [comment]);
    assert.equal(launches.length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  console.log('Inline emoji choices, user identity, stale decisions and durable dispatch checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
