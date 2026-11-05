'use strict';

const { createHash } = require('node:crypto');

const VERSION = 1;
const MAX_EVENTS = 180;
const MAX_EVENT_TEXT = 320;
const MAX_EVENT_DETAILS = 1800;
const SHA = /^[0-9a-f]{40,64}$/i;

// Per-session keys avoid different merge windows overwriting one another.
// The original selected head is stable across automatic branch synchronization.
function stateKey(selection) {
  const identity = JSON.stringify(selection.pullRequests.map(pr => [pr.number, pr.headSha, pr.base]));
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return 'sweetiebot.mergeDashboard.v1.' + selection.repository + '.' + digest;
}

function validEvent(event, numbers) {
  if (!event || !numbers.has(event.number) ||
      typeof event.state !== 'string' || typeof event.message !== 'string' ||
      typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) return null;
  return {
    number: event.number,
    state: event.state.slice(0, 36),
    ...(['local', 'upstream', 'review'].includes(event.location) ? { location: event.location } : {}),
    message: event.message.slice(0, MAX_EVENT_TEXT),
    ...(typeof event.details === 'string' && event.details
      ? { details: event.details.slice(0, MAX_EVENT_DETAILS) } : {}),
    at: event.at
  };
}

function createMergeDashboardPersistence(context, selection) {
  const storage = context?.workspaceState;
  const key = stateKey(selection);
  const numbers = new Set(selection.pullRequests.map(pr => pr.number));
  let previous;
  try { previous = storage?.get?.(key); }
  catch { /* A damaged storage provider must not block live GitHub verification. */ }
  if (previous?.version !== VERSION) previous = {};
  const events = (Array.isArray(previous.events) ? previous.events : [])
    .slice(-MAX_EVENTS).map(event => validEvent(event, numbers)).filter(Boolean);
  const recovery = {};
  for (const pr of selection.pullRequests) {
    const entry = previous.recovery?.[pr.number];
    if (entry?.headSha !== pr.headSha ||
        typeof entry.stage !== 'string' || typeof entry.at !== 'string' ||
        !Number.isFinite(Date.parse(entry.at))) continue;
    recovery[pr.number] = {
      headSha: pr.headSha, stage: entry.stage.slice(0, 48),
      lastPushedHead: SHA.test(entry.lastPushedHead || '') ? entry.lastPushedHead : '',
      at: entry.at
    };
  }
  const state = {
    version: VERSION,
    selectedNumber: numbers.has(previous.selectedNumber) ? previous.selectedNumber : null,
    events,
    recovery
  };
  let writes = Promise.resolve();
  function save() {
    if (typeof storage?.update !== 'function') return;
    const snapshot = {
      version: VERSION, selectedNumber: state.selectedNumber,
      events: state.events.slice(), recovery: { ...state.recovery }
    };
    // Preserve write order even when VS Code's Memento updates are asynchronous.
    writes = writes.catch(() => {}).then(() => storage.update(key, snapshot)).catch(() => {});
  }
  return {
    key,
    // History and recovery notes are deliberately NOT PR eligibility state.
    restoredEvents: events.map(event => ({ ...event, historical: true })),
    restoredRecovery: { ...recovery },
    selectedNumber: () => state.selectedNumber,
    select(number) {
      if (!numbers.has(number) || state.selectedNumber === number) return;
      state.selectedNumber = number;
      save();
    },
    recordEvent(event) {
      const clean = validEvent(event, numbers);
      if (!clean) return;
      state.events.push(clean);
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
      save();
    },
    recordRecovery(number, originalHead, stage, lastPushedHead = '') {
      const selected = selection.pullRequests.find(pr => pr.number === number);
      if (!selected || selected.headSha !== originalHead ||
          typeof stage !== 'string' || !stage || stage.length > 48) return null;
      const entry = {
        headSha: originalHead, stage,
        lastPushedHead: SHA.test(lastPushedHead) ? lastPushedHead : '',
        at: new Date().toISOString()
      };
      state.recovery[number] = entry;
      save();
      return entry;
    },
    flush: () => writes
  };
}

module.exports = { createMergeDashboardPersistence, stateKey };
