'use strict';

const { validateSelection } = require('./merge_dashboard');
const { createMergeHandoff } = require('./merge_handoff');
const { validateResolution, resolutionInstructions } = require('./merge_resolution');
const SHA = /^[a-f0-9]{40}$/i;

async function createMergeBatch(rawSelection, { api, execute, makePrompt, destination,
  onResult = async () => {}, onState = async () => {}, maxRounds = rawSelection.pullRequests.length * 4 + 4 } = {}) {
  const original = validateSelection(rawSelection);
  const entries = new Map(original.pullRequests.map(pr => [pr.number, { ...pr, attempts: 0 }]));
  const merged = [], deferred = [], history = [], bridges = [];
  let round = 0, emptyRounds = 0, disposed = false;

  const state = () => ({ repository: original.repository, pullRequests: [...entries.values()].map(({ attempts, ...pr }) => pr), round, merged: [...merged], deferred: [...deferred], history: [...history] });
  const remaining = () => [...entries.values()].filter(pr => !merged.some(item => item.number === pr.number)
    && !deferred.some(item => item.number === pr.number));

  async function refreshRemaining() {
    for (const pr of remaining()) {
      const fresh = await api('repos/' + original.repository + '/pulls/' + pr.number);
      if (fresh.state !== 'open' || fresh.merged || fresh.draft || fresh.head?.sha !== pr.headSha ||
          fresh.head?.ref !== pr.head || fresh.base?.ref !== pr.base || fresh.title !== pr.title ||
          fresh.head?.repo?.full_name !== original.repository) {
        deferred.push({ number: pr.number, reason: 'The selected PR changed outside this batch; review the new head or PR state.' });
        continue;
      }
      const base = await api('repos/' + original.repository + '/branches/' + encodeURIComponent(pr.base));
      if (!SHA.test(base.commit?.sha || '')) throw Error('Cannot verify the remaining PR base.');
      pr.baseSha = base.commit.sha;
      if (pr.initialBaseSha === undefined) {
        pr.initialBaseSha = pr.baseSha;
        pr.initialMergeable = fresh.mergeable;
      }
      pr.mergeable = fresh.mergeable;
      pr.baseAdvanced = pr.baseSha !== pr.initialBaseSha;
    }
  }

  function validateRound(input, selection) {
    validateResolution(input, selection);
    if (input.results.length > 1) throw Error('Return one PR per round so the next resolution uses the actual merged base.');
    if (input.deferred !== undefined && (!Array.isArray(input.deferred) || input.deferred.length > selection.pullRequests.length)) {
      throw Error('Invalid deferred PR decisions.');
    }
    const seen = new Set(input.results.map(item => item.number));
    for (const item of input.deferred || []) {
      const pr = selection.pullRequests.find(pr => pr.number === item?.number);
      if (!pr || seen.has(item.number) || item.headSha !== pr.headSha ||
          !['human_review', 'capability', 'failed_checks'].includes(item.kind) ||
          typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 4000) {
        throw Error('Deferred decisions must identify a current selected PR and its specific non-routine blocker.');
      }
      seen.add(item.number);
    }
  }

  async function startRound() {
    if (disposed) return null;
    await refreshRemaining();
    if (!remaining().length || round >= maxRounds) {
      for (const pr of remaining()) deferred.push({ number: pr.number, reason: 'Automatic integration retry limit reached; inspect the latest report.' });
      await onState(state());
      return null;
    }
    round++;
    const snapshots = remaining().map(pr => ({ ...pr }));
    const selection = validateSelection({ repository: original.repository, pullRequests: snapshots });
    let submitted;
    const bridge = await createMergeHandoff(selection, {
      validate: validateRound,
      execute: async (input, selected) => { submitted = input; return execute(input, selected); },
      onResult: async result => {
        // Dashboard rendering must not prevent a verified Git result from
        // advancing the coordinator (for example, after its panel is closed).
        try { await onResult(result); } catch { /* State below remains authoritative. */ }
        for (const decision of submitted.deferred || []) deferred.push({ ...decision });
        if (result.results.length) emptyRounds = 0;
        else emptyRounds++;
        for (const item of result.results) {
          const pr = entries.get(item.number);
          const input = submitted.results.find(entry => entry.number === item.number);
          if (!pr || !input) throw Error('Local result does not match the submitted round.');
          pr.attempts++;
          const detail = { number: item.number, title: pr.title, base: pr.base,
            status: item.status, explanation: input.explanation, decisions: require('./resolution_commits').validateDecisions(input.decisions), reason: item.reason || '',
            sourceHeadSha: input.headSha, destinationSha: item.merged ? item.sha : undefined,
            conflictPaths: item.conflictPaths || [], baseSha: item.baseSha || pr.baseSha };
          history.push(detail);
          if (item.merged === true && item.status === 'merged') merged.push(detail);
          else if (['synced', 'waiting', 'checks_failed', 'needs_refresh'].includes(item.status) && item.previousHeadSha === pr.headSha && SHA.test(item.sha || '')) {
            // Only our verified executor can refresh an authorized head.
            pr.headSha = item.sha;
          }
          if (item.status === 'checks_failed') deferred.push({ number: pr.number, reason: item.reason });
          else if (!item.merged && (item.status === 'blocked' || pr.attempts >= 3)) deferred.push({ number: pr.number,
            reason: item.reason || 'Repeated integration attempts require inspection.' });
        }
        // Empty results cannot silently abandon remaining routine integration.
        if (emptyRounds >= 2) for (const pr of remaining()) deferred.push({ number: pr.number,
          reason: 'No executable resolution was returned after a refreshed-base retry.' });
        await onState(state());
        const next = await startRound();
        return { batch: state(), ...(next ? { continueUrl: next.url } : {}) };
      }
    });
    bridges.push(bridge);
    const compact = item => ({ ...item, explanation: item.explanation?.slice(0, 900),
      reason: item.reason?.slice(0, 600), conflictPaths: item.conflictPaths?.slice(0, 20) });
    const previous = history.slice(-3).map(compact);
    const instructions = [
      'AUTOMATIC SEQUENTIAL BULK MERGE — ROUND ' + round + ': Work only on the remaining selected PRs below. Return at most ONE PR for local execution per round. Do not merge any PR directly through GitHub tools: the local runner preserves attribution, integrates the latest base, waits for checks, and verifies the destination commit. Its result automatically starts the next round.',
      'QUEUE ORDER: Follow the supplied oldest-first selected order, preserving ancestor-before-descendant stack ordering. Return the oldest eligible remaining PR for local execution; skip genuine blockers and continue in order rather than choosing the newest PR.',
      'ROUTINE INTEGRATION POLICY: Earlier successful merges in THIS batch are authoritative base changes, not a reason to stop. Infer clear ordering from their verified changes and the remaining PR’s feature intent. Preserve what is now on main and add the remaining proposed features. Use common ancestor + current base + PR head when reconciling overlaps; never restore outdated code just because it appears in an old PR diff. Try the local three-way Git route first with patch:null; for needs_resolution, inspect the overlapping files and provide the complete current-base resolution patch. Do this autonomously when both intentions are clear. A Git textual conflict, base advancement, or old failing checks alone does not require human help.',
      'Verified completed merge intent: ' + JSON.stringify(merged.map(compact)),
      'Recent local integration results: ' + JSON.stringify(previous),
      'Refreshed selected snapshots: ' + JSON.stringify(snapshots.map(pr => ({ number: pr.number, title: pr.title,
        head: pr.head, headSha: pr.headSha, base: pr.base, baseSha: pr.baseSha,
        initiallyMergeable: pr.initialMergeable, baseAdvancedByEarlierWork: pr.baseAdvanced }))),
      'Reassess remaining PRs after every merge. Do not treat checks from the old PR head as checks on the integrated tree. Local preparation is allowed to incorporate the new base; merging still requires the resulting head’s checks to pass. Actual fresh check failures and ambiguous behavior choices remain blockers. Update existing tagged reports rather than duplicating them.',
      'For a genuine non-routine blocker, include deferred:[{"number":123,"headSha":"exact selected head","kind":"human_review|capability|failed_checks","reason":"specific ambiguity or actual failure"}] in the versioned result JSON. Do not defer routine integration merely because it needs a new Git resolution. Continue unrelated remaining PRs. An unrelated external head/title/base-branch change is outside this batch’s snapshot and must not be overwritten.',
      require('./merge_blocker_actions').reportOptionsInstructions(),
      resolutionInstructions(selection, bridge.url)
    ].join('\n\n');
    const prompt = (makePrompt ? makePrompt(selection) + '\n\n' : '') + instructions;
    const url = new URL(destination);
    url.hash = new URLSearchParams({ sweetiebot_merge: '1', q: prompt, return_to: bridge.url }).toString();
    if (Buffer.byteLength(url.href) > 70000) throw Error('The refreshed batch prompt exceeds the browser launch budget.');
    await onState(state());
    return { url: url.href, callback: bridge.url, instructions };
  }

  const first = await startRound();
  return { ...first, state, dispose() { disposed = true; for (const bridge of bridges) bridge.dispose(); } };
}

module.exports = { createMergeBatch };
