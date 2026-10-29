'use strict';

const { validateSelection } = require('./dashboard');
const { createMergeHandoff } = require('./handoff');
const { validateResolution, validateSyncResolution, resolutionInstructions } = require('./resolution');
const SHA = /^[a-f0-9]{40}$/i;
const { orderMergeCandidates } = require('./order');

async function createMergeBatch(rawSelection, { api, execute, makePrompt, destination,
  onResult = async () => {}, onState = async () => {}, onProgress = () => {}, reviewOrder = 'Oldest first', branchOnly = false, maxRounds = rawSelection.pullRequests.length * 4 + 4 } = {}) {
  const original = validateSelection(rawSelection);
  const entries = new Map(original.pullRequests.map(pr => [pr.number, { ...pr, attempts: 0 }]));
  const merged = [], prepared = [], deferred = [], history = [], bridges = [];
  let round = 0, emptyRounds = 0, disposed = false, rateLimit, executing = false, reconciling = false;
  let generation = 0;
  const activities = {};
  const activity = (number, phase, message) => {
    activities[number] = { phase, message, round, at: new Date().toISOString() };
  };

  const state = () => ({ ...(rateLimit ? {rateLimit} : {}), repository: original.repository, activities: structuredClone(activities), pullRequests: [...entries.values()].map(({ attempts, ...pr }) => pr), round, merged: [...merged], ...(branchOnly ? {prepared:[...prepared]} : {}), deferred: [...deferred], history: [...history] });
  const remaining = () => [...entries.values()].filter(pr => !merged.some(item => item.number === pr.number)
    && !deferred.some(item => item.number === pr.number) && !prepared.some(item => item.number === pr.number));

  async function refreshRemaining() {
    const pending = remaining();
    for (const [index, pr] of pending.entries()) {
      onProgress({ message: `Verifying PR #${pr.number} (${index + 1}/${pending.length})` });
      activity(pr.number, 'verifying', 'Checking current PR head, base and merge eligibility');
      await onState(state());
      const fresh = await api('repos/' + original.repository + '/pulls/' + pr.number);
      // GitHub can retarget an open child when this batch merges and deletes
      // its parent branch. Accept only that verified parent's destination;
      // the child's selected head, title and repository must still match.
      const parent = [...entries.values()].find(candidate => candidate.head === pr.base &&
        merged.some(item => item.number === candidate.number));
      const expectedBase = parent && fresh.base?.ref === parent.base ? parent.base : pr.base;
      if (fresh.state !== 'open' || fresh.merged || fresh.draft || fresh.head?.sha !== pr.headSha ||
          fresh.head?.ref !== pr.head || fresh.base?.ref !== expectedBase || fresh.title !== pr.title ||
          fresh.head?.repo?.full_name !== original.repository) {
        deferred.push({ number: pr.number, kind: 'snapshot_changed', reason: 'The selected PR changed outside this batch; review the new head or PR state.' });
        activity(pr.number, 'blocked', 'PR snapshot changed; waiting for a verified repair or fresh selection');
        continue;
      }
      pr.base = expectedBase;
      const base = await api('repos/' + original.repository + '/branches/' + encodeURIComponent(pr.base));
      if (!SHA.test(base.commit?.sha || '')) throw Error('Cannot verify the remaining PR base.');
      pr.baseSha = base.commit.sha;
      if (pr.initialBaseSha === undefined) {
        pr.initialBaseSha = pr.baseSha;
        pr.initialMergeable = fresh.mergeable;
      }
      pr.mergeable = fresh.mergeable;
      pr.mergeableState = fresh.mergeable_state;
      if (Number.isFinite(fresh.additions) && Number.isFinite(fresh.deletions)) {
        pr.changeSize = fresh.additions + fresh.deletions;
      }
      pr.waitingFor = [...entries.values()].filter(parent => parent.number !== pr.number && parent.head === pr.base
        && !merged.some(item => item.number === parent.number)).map(parent => parent.number);
      pr.baseAdvanced = pr.baseSha !== pr.initialBaseSha;
    }
  }

  function validateRound(input, selection) {
    (branchOnly ? validateSyncResolution : validateResolution)(input, selection);
    if (input.results.length > 1) throw Error('Return one PR per round so the next resolution uses the actual merged base.');
    for (const item of input.results) {
      const pr = entries.get(item.number);
      if (pr.waitingFor?.length) throw Error('Merge the selected ancestor before its dependent PR.');
    }
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
    if (rateLimit) return null;
    try { await refreshRemaining(); } catch (error) {
      if (!error.rateLimited) throw error;
      rateLimit = {message:error.message,retryAt:error.retryAt,configured:error.configured};
      await onState(state());
      return null;
    }
    if (!remaining().length || round >= maxRounds) {
      for (const pr of remaining()) deferred.push({ number: pr.number, reason: 'Automatic integration retry limit reached; inspect the latest report.' });
      await onState(state());
      return null;
    }
    round++;
    const currentGeneration = ++generation;
    const snapshots = orderMergeCandidates(remaining()).map(({ attempts, ...pr }) => ({ ...pr }));
    const selection = validateSelection({ repository: original.repository, pullRequests: snapshots });
    for (const pr of snapshots) activity(pr.number, 'reviewing', 'Review round ' + round + ' · waiting for GPT to return a current-base handoff');
    let submitted;
    const bridge = await createMergeHandoff(selection, {
      validate: (input, selected) => {
        if (disposed || reconciling || currentGeneration !== generation) throw Error('This handoff is stale; use the refreshed merge review.');
        validateRound(input, selected);
      },
      execute: async (input, selected) => {
        executing = true;
        submitted = input;
        try {
          for (const item of input.results) activity(item.number, 'applying', 'Handoff received · waiting for local execution');
          await onState(state());
          return await execute(input, selected);
        } catch (error) {
          executing = false;
          for (const item of input.results) activity(item.number, 'blocked', 'Local execution failed; inspect the handoff error');
          try { await onState(state()); } catch { /* Preserve the execution error. */ }
          throw error;
        }
      },
      onResult: async result => {
        try {
        // Dashboard rendering must not prevent a verified Git result from
        // advancing the coordinator (for example, after its panel is closed).
        try { await onResult(result); } catch { /* State below remains authoritative. */ }
        for (const decision of submitted.deferred || []) {
          deferred.push({ ...decision });
          activity(decision.number, 'blocked', 'Review stopped · ' + decision.reason);
        }
        if (result.results.length) emptyRounds = 0;
        else emptyRounds++;
        for (const item of result.results) {
          const pr = entries.get(item.number);
          const input = submitted.results.find(entry => entry.number === item.number);
          if (!pr || !input) throw Error('Local result does not match the submitted round.');
          activity(item.number, item.status, item.merged ? 'GitHub merge confirmed' : ({
            needs_resolution: 'Conflict found · preparing a fresh resolution review',
            needs_refresh: 'Base advanced · regenerating the integration handoff',
            checks_failed: 'Integrated-head checks failed · assessing repair',
            waiting: 'Waiting for integrated-head checks', synced: 'PR branch synchronization finished',
            blocked: 'Local execution stopped · attention required'
          }[item.status] || 'Local execution finished'));
          if (item.rateLimited) { rateLimit = {message:item.reason,retryAt:item.retryAt,configured:item.configured}; continue; }
          // A parallel lane can advance the base before any local work starts.
          // Regenerating that untouched patch is bounded by maxRounds, rather
          // than consuming the PR's budget for actual integration failures.
          if (!(item.status === 'needs_refresh' && item.retryableBaseAdvance === true)) pr.attempts++;
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
          if (branchOnly && item.status === 'synced') prepared.push(detail);
          if (!branchOnly && item.status === 'synced' && item.unchanged === true) deferred.push({ number: pr.number,
            reason: item.reason || 'Nothing needed synchronization; do not retry the unchanged branch.' });
          if (item.status === 'checks_failed') {
            pr.checkFailures = (pr.checkFailures || 0) + 1;
            // Give the next AI round the verified failing head before deferring.
            if (pr.checkFailures >= 2 || pr.attempts >= 3) deferred.push({ number: pr.number, reason: item.reason });
          }
          else if (!item.merged && !(branchOnly && item.status === 'synced') && (item.status === 'blocked' || pr.attempts >= 3)) deferred.push({ number: pr.number, ...(item.kind ? { kind: item.kind } : {}),
            reason: item.reason || 'Repeated integration attempts require inspection.' });
        }
        // Empty results cannot silently abandon remaining routine integration.
        if (emptyRounds >= 2) for (const pr of remaining()) deferred.push({ number: pr.number,
          reason: 'No executable resolution was returned after a refreshed-base retry.' });
        await onState(state());
        const next = await startRound();
        return { batch: state(), ...(next ? { continueUrl: next.url } : {}) };
        } finally { executing = false; }
      }
    });
    bridges.push(bridge);
    const compact = item => ({ ...item, explanation: item.explanation?.slice(0, 900),
      reason: item.reason?.slice(0, 600), conflictPaths: item.conflictPaths?.slice(0, 20) });
    const previous = history.slice(-3).map(compact);
    const instructions = [
      ...(branchOnly ? ['BRANCH-ONLY EXECUTION: This is an automatic PR repair loop. Every result MUST use operation:"sync". Main is read-only; merging and closing the PR are not authorized. A needs_resolution result automatically starts the next GPT round with the named conflicted files and current-base snapshots. Inspect both intentions and return the complete resolution patch. A synced result completes this repair task without merging the PR. These restrictions override all merge-oriented instructions below.'] : []),
      'AUTOMATIC SEQUENTIAL BULK MERGE — ROUND ' + round + ': Work only on the remaining selected PRs below. Return at most ONE PR for local execution per round. Do not merge any PR directly through GitHub tools: the local runner preserves attribution, integrates the latest base, waits for checks, and verifies the destination commit. Its result automatically starts the next round.',
      'INTELLIGENT MERGE ORDER: Follow the refreshed priority order below. Selected ancestors must merge before their descendants; never execute a PR with waitingFor ancestors. Prefer clean, ready PRs over unknown readiness, conflicts, and failing or blocked checks. Among equally ready PRs, avoid repeating a stuck attempt while other work can progress, prefer ancestors that unlock selected children, then smaller integrations. Lane direction (' + reviewOrder + ') breaks remaining ties only. This priority overrides any global oldest-first instruction. Reassess after each verified result; preserve merged intent and never bypass checks. If code inspection reveals a feature dependency beyond the branch stack, resolve that selected dependency first or defer the dependent PR with the exact reason.',
      'ROUTINE INTEGRATION POLICY: Earlier successful merges in THIS batch are authoritative base changes, not a reason to stop. Infer clear ordering from their verified changes and the remaining PR’s feature intent. Preserve what is now on main and add the remaining proposed features. Use common ancestor + current base + PR head when reconciling overlaps; never restore outdated code just because it appears in an old PR diff. Try the local three-way Git route first with patch:null; for needs_resolution, inspect the overlapping files and provide the complete current-base resolution patch. Do this autonomously when both intentions are clear. A Git textual conflict, base advancement, or old failing checks alone does not require human help.',
      'Verified completed merge intent: ' + JSON.stringify(merged.map(compact)),
      'Recent local integration results: ' + JSON.stringify(previous),
      'Refreshed selected snapshots: ' + JSON.stringify(snapshots.map(pr => ({ number: pr.number, title: pr.title,
        head: pr.head, headSha: pr.headSha, base: pr.base, baseSha: pr.baseSha,
        mergeable: pr.mergeable, mergeableState: pr.mergeableState, waitingFor: pr.waitingFor, changeSize: pr.changeSize,
        initiallyMergeable: pr.initialMergeable, baseAdvancedByEarlierWork: pr.baseAdvanced }))),
      'Reassess remaining PRs after every merge. Do not treat checks from the old PR head as checks on the integrated tree. Local preparation is allowed to incorporate the new base; merging still requires the resulting head’s checks to pass. On the first fresh check failure, inspect the actual failing job logs and attempt the smallest behavior-preserving repair through the existing complete current-base patch handoff with repairChecks:true (supporting regression test files are permitted only after the runner independently confirms checks failed on that exact head). Do not resubmit the same failing tree or merely rerun deterministic failures. Retain the PR feature and passing-check gate. Defer with the exact limitation if a repair exceeds the allowed PR file set, requires unavailable tools or authorization, or changes ambiguous behavior. A second failed repair is deferred; never loop indefinitely. Ambiguous behavior choices remain blockers. Update existing tagged reports rather than duplicating them.',
      'For a genuine non-routine blocker, include deferred:[{"number":123,"headSha":"exact selected head","kind":"human_review|capability|failed_checks","reason":"specific ambiguity or actual failure"}] in the versioned result JSON. Do not defer routine integration merely because it needs a new Git resolution. Continue unrelated remaining PRs. An unrelated external head/title/base-branch change is outside this batch’s snapshot and must not be overwritten.',
      require('./blocker_actions').reportOptionsInstructions(),
      resolutionInstructions(selection, bridge.url)
    ].join('\n\n');
    const prompt = (makePrompt ? makePrompt(selection) + '\n\n' : '') + instructions;
    const url = new URL(destination);
    bridge.setPrompt(prompt);
    url.searchParams.set('sweetiebot_launch', new URL(bridge.url).pathname.split('/').pop());
    url.hash = new URLSearchParams({ sweetiebot_merge: '1', return_to: bridge.url }).toString();
    await onState(state());
    return { url: url.href, callback: bridge.url, instructions };
  }

  const first = await startRound();
  async function reconcile(repairedNumbers = []) {
    if (disposed || rateLimit || executing || reconciling) return null;
    reconciling = true;
    let changed = false;
    const updates = [];
    try {
      for (const pr of entries.values()) {
        if (merged.some(item => item.number === pr.number) || prepared.some(item => item.number === pr.number)) continue;
        const blocked = deferred.find(item => item.number === pr.number);
        // Only stale-snapshot deferrals can be cleared by a repaired head.
        if (blocked && (blocked.kind || !/selected PR (?:head, base or title changed|changed outside this batch)/i.test(blocked.reason))) continue;
        const fresh = await api('repos/' + original.repository + '/pulls/' + pr.number);
        if (fresh.title !== pr.title || fresh.head?.ref !== pr.head || fresh.base?.ref !== pr.base ||
            fresh.head?.repo?.full_name !== original.repository) continue;
        if (fresh.merged === true && SHA.test(fresh.merge_commit_sha || '')) {
          updates.push({ pr, blocked, mergedSha: fresh.merge_commit_sha });
          continue;
        }
        if (!repairedNumbers.includes(pr.number) || fresh.state !== 'open' || fresh.draft ||
            fresh.mergeable !== true || !SHA.test(fresh.head?.sha || '') || fresh.head.sha === pr.headSha) continue;
        const compared = await api('repos/' + original.repository + '/compare/' + pr.headSha + '...' + fresh.head.sha);
        if (compared.status !== 'ahead' || compared.merge_base_commit?.sha !== pr.headSha) continue;
        updates.push({ pr, blocked, headSha: fresh.head.sha });
      }
      for (const { pr, blocked, mergedSha, headSha } of updates) {
        if (mergedSha) merged.push({ number: pr.number, title: pr.title, base: pr.base, status: 'merged', destinationSha: mergedSha });
        else {
          pr.headSha = headSha;
          pr.attempts = 0;
          pr.checkFailures = 0;
          activity(pr.number, 'refreshing', 'Repair commit verified · retiring stale patches and requesting a fresh review');
        }
        const index = deferred.indexOf(blocked);
        if (index >= 0) deferred.splice(index, 1);
        changed = true;
      }
      if (!changed) return null;
      // A patch from the previous generation must never reach the executor.
      generation++;
      emptyRounds = 0;
      for (const bridge of bridges) bridge.dispose();
      await onState(state());
      return await startRound();
    } finally { reconciling = false; }
  }
  return { ...first, state, reconcile, dispose() { disposed = true; for (const bridge of bridges) bridge.dispose(); } };
}

module.exports = { createMergeBatch };
