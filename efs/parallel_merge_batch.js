'use strict';

const { createMergeBatch } = require('./merge_batch');
const { validateSelection } = require('./merge_dashboard');

// A stack or a shared file makes one review unit. Different units can be
// researched concurrently without two GPT sessions owning the same changes.
function planMergeLanes(selection, files, limit = 3) {
  const prs = selection.pullRequests;
  const groups = prs.map((_, index) => index);
  const find = index => groups[index] === index ? index : (groups[index] = find(groups[index]));
  const join = (a, b) => { groups[find(b)] = find(a); };
  for (let i = 0; i < prs.length; i++) for (let j = i + 1; j < prs.length; j++) {
    const a = prs[i], b = prs[j];
    if (!files.has(a.number) || !files.has(b.number) || a.base === b.head || b.base === a.head ||
        a.head === b.head || files.get(a.number).some(file => files.get(b.number).includes(file))) join(i, j);
  }
  const components = new Map();
  prs.forEach((pr, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(pr);
  });
  const lanes = Array.from({ length: Math.min(limit, components.size) }, () => []);
  for (const component of components.values()) {
    const lane = lanes.reduce((best, next) => next.flat().length < best.flat().length ? next : best);
    const ordered = [], pending = [...component];
    while (pending.length) {
      const index = pending.findIndex(pr => !pending.some(parent => parent !== pr && parent.head === pr.base));
      // Cyclic branch relationships cannot be scheduled as independent work.
      if (index < 0) { ordered.push(...pending); break; }
      ordered.push(...pending.splice(index, 1));
    }
    lane.push(ordered);
  }
  const labels = ['Oldest first', 'Newest first', 'Middle first'];
  return lanes.map((units, index) => {
    if (index === 1) units.reverse();
    if (index === 2) {
      const middle = Math.floor(units.length / 2);
      units = [units[middle], ...units.slice(0, middle), ...units.slice(middle + 1)];
    }
    return { id: index + 1, label: labels[index], pullRequests: units.flat() };
  });
}

async function createParallelMergeBatch(rawSelection, options = {}) {
  const selection = validateSelection(rawSelection);
  const { api, onState = async () => {}, onProgress = () => {}, execute,
    makePrompt, maxWorkers = 3, threshold = 8 } = options;
  if (selection.pullRequests.length < threshold || maxWorkers < 2) return createMergeBatch(selection, options);
  const files = new Map();
  // Filenames only: never fetch file contents to decide whether work is independent.
  for (const pr of selection.pullRequests) {
    onProgress({ message: 'Checking independent work for PR #' + pr.number });
    const names = [];
    let complete = false;
    try {
      for (let page = 1; page <= 10; page++) {
        const result = await api('repos/' + selection.repository + '/pulls/' + pr.number + '/files?per_page=100&page=' + page);
        if (!Array.isArray(result) || result.some(file => typeof file.filename !== 'string')) break;
        names.push(...result.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]));
        if (result.length < 100) { complete = true; break; }
      }
    } catch (error) { if (error.rateLimited) throw error; }
    if (complete) files.set(pr.number, [...new Set(names)]);
  }
  const lanes = planMergeLanes(selection, files, Math.max(1, Math.min(3, maxWorkers)));
  if (lanes.length < 2) return createMergeBatch(selection, options);
  const batches = [];
  const states = new Map(lanes.map(lane => [lane.id, {
    repository: selection.repository, pullRequests: lane.pullRequests, round: 0, merged: [], deferred: [], history: []
  }]));
  const phases = new Map(lanes.map(lane => [lane.id, 'Starting']));
  let disposed = false, rateLimit, executionTail = Promise.resolve(), publicationTail = Promise.resolve();
  function state() {
    const all = [...states.values()];
    const pullRequests = new Map(all.flatMap(item => item.pullRequests).map(pr => [pr.number, pr]));
    rateLimit ||= all.find(item => item.rateLimit)?.rateLimit;
    return { repository: selection.repository,
      pullRequests: selection.pullRequests.map(pr => pullRequests.get(pr.number) || pr),
      round: all.reduce((sum, item) => sum + item.round, 0),
      merged: all.flatMap(item => item.merged), deferred: all.flatMap(item => item.deferred),
      history: all.flatMap(item => item.history), ...(rateLimit ? { rateLimit } : {}),
      workers: lanes.map(lane => ({ id: lane.id, label: lane.label, phase: phases.get(lane.id),
        numbers: lane.pullRequests.map(pr => pr.number),
        merged: states.get(lane.id).merged.length, total: lane.pullRequests.length })) };
  }
  function publish() {
    const snapshot = state();
    const next = publicationTail.then(() => onState(snapshot));
    publicationTail = next.catch(() => {});
    return next;
  }
  async function executeOne(lane, input, selected) {
    phases.set(lane.id, 'Waiting to apply');
    await publish();
    const next = executionTail.then(async () => {
      if (disposed) throw Error('This parallel merge batch was closed.');
      if (rateLimit) return { repository: selection.repository, results: input.results.map(item => ({
        number: item.number, status: 'waiting', rateLimited: true, reason: rateLimit.message,
        retryAt: rateLimit.retryAt, configured: rateLimit.configured })) };
      phases.set(lane.id, 'Applying');
      await publish();
      // A different lane may have merged while GPT was reviewing. Complete
      // patches belong to one exact base; stale patches must be regenerated.
      const results = [], summaryErrors = [];
      for (const item of input.results) {
        const pr = selected.pullRequests.find(pr => pr.number === item.number);
        const fresh = await api('repos/' + selection.repository + '/pulls/' + pr.number);
        if (fresh.state !== 'open' || fresh.merged || fresh.draft || fresh.title !== pr.title ||
            fresh.head?.sha !== pr.headSha || fresh.head?.ref !== pr.head || fresh.base?.ref !== pr.base ||
            fresh.head?.repo?.full_name !== selection.repository) {
          results.push({ number: pr.number, status: 'blocked', merged: false,
            reason: 'The selected PR changed while its parallel review was running; select its current snapshot again.' });
          continue;
        }
        const base = await api('repos/' + selection.repository + '/branches/' + encodeURIComponent(pr.base));
        if (!/^[a-f0-9]{40}$/i.test(base.commit?.sha || '')) throw Error('Cannot verify the current integration base.');
        if (item.patch !== null && item.baseSha !== base.commit.sha) {
          results.push({ number: pr.number, status: 'needs_refresh', merged: false,
            retryableBaseAdvance: true,
            reason: 'Another review lane advanced the base. Regenerate the complete patch against the refreshed base.' });
          continue;
        }
        const executed = await execute({ ...input, results: [item] }, selected);
        results.push(...executed.results);
        summaryErrors.push(...(executed.summaryErrors || []));
        const limited = executed.results.find(result => result.rateLimited);
        if (limited) rateLimit = { message: limited.reason, retryAt: limited.retryAt, configured: limited.configured };
      }
      return { repository: selection.repository, results, summaryErrors };
    });
    executionTail = next.catch(() => {});
    try { return await next; }
    catch (error) {
      if (!error.rateLimited) throw error;
      rateLimit = { message: error.message, retryAt: error.retryAt, configured: error.configured };
      return { repository: selection.repository, results: input.results.map(item => ({
        number: item.number, status: 'waiting', rateLimited: true, reason: error.message,
        retryAt: error.retryAt, configured: error.configured })) };
    }
    finally { phases.set(lane.id, 'Reviewing'); }
  }
  try {
    // Create independent one-use callback chains; each owns a disjoint selection.
    const launches = [];
    for (const lane of lanes) {
      const batch = await createMergeBatch({ repository: selection.repository, pullRequests: lane.pullRequests }, {
        ...options,
        makePrompt: snapshot => [makePrompt ? makePrompt(snapshot) : '',
          'PARALLEL REVIEW LANE ' + lane.id + ' — ' + lane.label + '. Work only on your assigned PRs. Other lanes own different PRs. Local writes are coordinated; never merge directly with GitHub tools. If another lane advances the base, preserve its verified work and regenerate stale resolution patches.',
          'Recent verified merges across all lanes: ' + JSON.stringify(state().merged.slice(-12).map(item => ({
            number: item.number, title: item.title?.slice(0, 160), base: item.base,
            explanation: item.explanation?.slice(0, 240), destinationSha: item.destinationSha
          })))
        ].filter(Boolean).join('\n\n'),
        execute: (input, selected) => executeOne(lane, input, selected),
        onState: async current => {
          states.set(lane.id, current);
          const settled = current.merged.length + current.deferred.length;
          phases.set(lane.id, current.rateLimit ? 'Rate limited' : settled === lane.pullRequests.length ? 'Finished' : 'Reviewing');
          await publish();
        }
      });
      batches.push(batch);
      if (batch.url) launches.push({ id: lane.id, label: lane.label, url: batch.url });
    }
    return { launches, state, dispose() { disposed = true; for (const batch of batches) batch.dispose(); } };
  } catch (error) { disposed = true; for (const batch of batches) batch.dispose(); throw error; }
}

module.exports = { planMergeLanes, createParallelMergeBatch };
