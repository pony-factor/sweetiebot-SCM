'use strict';
const assert = require('node:assert/strict');
const { deferredCiRepairCandidate } = require('../../extension/merge/auto-ci-repair');
const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const pr = { number: 12, head: 'feature', base: 'main' };
const candidate = { ...pr, headSha, baseSha };
const state = { repository: 'o/r', pullRequests: [candidate],
  history: [{ number: 12, status: 'checks_failed' }],
  deferred: [{ number: 12, reason: 'CI failed after bounded retry' }] };
assert.deepEqual(deferredCiRepairCandidate(state, pr), candidate);
assert.equal(deferredCiRepairCandidate({ ...state, deferred: [] }, pr), null);
assert.equal(deferredCiRepairCandidate({ ...state, rateLimit: {} }, pr), null);
assert.equal(deferredCiRepairCandidate({ ...state, history: [{ number: 12, status: 'waiting' }] }, pr), null);
assert.equal(deferredCiRepairCandidate({ ...state, history: [...state.history, { number: 12, status: 'synced' }] }, pr), null);
assert.equal(deferredCiRepairCandidate({ ...state, pullRequests: [{ ...candidate, baseSha: 'bad' }] }, pr), null);
assert.equal(deferredCiRepairCandidate({ ...state, pullRequests: [{ ...candidate, headSha: 'bad' }] }, pr), null);
assert.equal(deferredCiRepairCandidate({ ...state, deferred: [{ number: 12, kind: 'human_review' }] }, pr), null);
assert.equal(deferredCiRepairCandidate(state, { ...pr, number: 13 }), null);
assert.equal(deferredCiRepairCandidate(state, { ...pr, base: 'other' }), null);
const stopped = { ...state, history: [{ number: 12, status: 'blocked' }],
  deferred: [{ number: 12, reason: 'Resolution patch contains an unsafe, secret-bearing or unrelated path.' }] };
const failing = { ...pr, state: 'checks', currentHead: headSha };
assert.deepEqual(deferredCiRepairCandidate(stopped, failing), candidate,
  'A stopped preparation does not prevent a fresh current-head CI repair');
assert.equal(deferredCiRepairCandidate(stopped, pr), null);
assert.equal(deferredCiRepairCandidate(stopped, { ...failing, state: 'checks-pending' }), null);
assert.equal(deferredCiRepairCandidate(stopped, { ...failing, currentHead: 'c'.repeat(40) }), null);
assert.equal(deferredCiRepairCandidate({ ...stopped,
  deferred: [{ number: 12, kind: 'human_review' }] }, failing), null);
console.log('Deferred CI auto-repair selection gates passed.');
