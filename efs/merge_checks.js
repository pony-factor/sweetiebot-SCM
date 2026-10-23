'use strict';

async function checkPages(api, endpoint, field) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const response = await api(endpoint + '?per_page=100&page=' + page);
    if (!Array.isArray(response?.[field])) throw Error('Cannot verify GitHub checks.');
    all.push(...response[field]);
    if (response[field].length < 100) return all;
  }
  throw Error('GitHub check history is incomplete.');
}

async function readMergeChecks(api, repository, sha, { expectChecks = false } = {}) {
  const root = 'repos/' + repository + '/commits/' + sha;
  const runs = await checkPages(api, root + '/check-runs', 'check_runs');
  const suites = await checkPages(api, root + '/check-suites', 'check_suites');
  const statuses = await checkPages(api, root + '/status', 'statuses');
  // Installed apps can leave queued suites with no jobs indefinitely. These
  // are not checks to wait for; GitHub's merge endpoint still enforces any
  // required checks that have not been created. Keep running/failed suites.
  const activeSuites = suites.filter(suite =>
    suite.status !== 'queued' || suite.latest_check_runs_count !== 0);
  // Reruns and legacy statuses can contain older failures for the same check.
  const latest = (items, key) => {
    const map = new Map();
    for (const item of items) {
      const id = key(item), prior = map.get(id);
      if (!prior || String(item.updated_at || item.completed_at || item.created_at || '') >
          String(prior.updated_at || prior.completed_at || prior.created_at || '') ||
          Number(item.id || 0) > Number(prior.id || 0)) map.set(id, item);
    }
    return [...map.values()];
  };
  const activeRuns = latest(runs, run => (run.app?.id || '') + ':' + run.name);
  const activeStatuses = latest(statuses, status => status.context);
  const passing = new Set(['success', 'neutral', 'skipped']);
  const failed = activeRuns.filter(run => run.status === 'completed' && !passing.has(run.conclusion))
    .map(run => String(run.name || 'GitHub check'));
  failed.push(...activeStatuses.filter(status => ['failure', 'error'].includes(status.state)).map(status => String(status.context)));
  failed.push(...suites.filter(suite => suite.status === 'completed' && suite.conclusion && !passing.has(suite.conclusion) &&
    !runs.some(run => suite.id && run.check_suite?.id === suite.id)).map(suite => String(suite.app?.name || 'GitHub check suite')));
  if (failed.length) return { state: 'failed', names: [...new Set(failed)], hasChecks: true };
  const hasChecks = Boolean(runs.length || activeSuites.length || statuses.length);
  const pending = activeRuns.some(run => run.status !== 'completed') ||
    activeSuites.some(suite => suite.status !== 'completed') ||
    activeStatuses.some(status => status.state !== 'success') ||
    (expectChecks && !hasChecks);
  return { state: pending ? 'pending' : 'passed', names: [], hasChecks };
}

async function waitForMergeChecks(api, repository, sha, { expectChecks = false,
  timeoutMs = 8 * 60 * 1000, intervalMs = 15000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await readMergeChecks(api, repository, sha, { expectChecks });
    if (result.state !== 'pending' || now() >= deadline) return result;
    await sleep(intervalMs);
  }
}

module.exports = { readMergeChecks, waitForMergeChecks };
