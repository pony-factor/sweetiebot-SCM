'use strict';

// Retain verified outcomes, not patches or credentials. Read preferences when
// publishing so changes apply to completed and currently executing rounds.
function createPublicationQueue(vscode, selection, { history = [], publish, onErrors = () => {} } = {}) {
  const records = new Map();
  let pending = Promise.resolve();
  function remember(snapshot, input, result) {
    for (const item of result.results || []) {
      const prepared = input.results.find(entry => entry.number === item.number);
      if (prepared && ['merged', 'synced', 'waiting', 'checks_failed'].includes(item.status) && item.sha) {
        const summary = { number: prepared.number, explanation: prepared.explanation,
          decisions: prepared.decisions?.length ? [true] : [], repairChecks: prepared.repairChecks === true,
          patch: !!prepared.patch, resolutionHunks: prepared.resolutionHunks?.length ? [true] : [] };
        records.set(item.number,
          { selection: snapshot, input: { results: [summary] }, result: { results: [item] } });
      }
    }
  }
  for (const item of history) {
    const sha = item.sha || item.destinationSha;
    if (!sha) continue;
    remember(selection, { results: [item] }, { results: [{ ...item, sha,
      merged: item.status === 'merged' }] });
  }
  function replay() {
    const next = pending.then(async () => {
      const config = vscode.workspace.getConfiguration('sweetiebot');
      const enabled = config.get('mergePostSummaries', false) === true;
      const postStatusUpdates = config.get('mergePostStatusUpdates', false) === true;
      if (!enabled && !postStatusUpdates) return [];
      const errors = [];
      for (const record of records.values()) {
        try { errors.push(...await publish({ ...record, enabled, postStatusUpdates })); }
        catch { errors.push({ number: record.result.results[0].number, error: 'Lindsey publication failed; the verified Git result is unchanged.' }); }
      }
      try { onErrors(errors); } catch { /* Notification failures cannot invalidate a merge. */ }
      return errors;
    });
    pending = next.catch(() => {});
    return next;
  }
  return { replay, async record(snapshot, input, result) { remember(snapshot, input, result); return replay(); } };
}
module.exports = { createPublicationQueue };
