'use strict';

// GitHub's PR metadata can briefly retain the pre-push head. Retry only that
// exact old snapshot, and only while Git confirms our pushed branch tip.
async function readPushedPR({ readPR, readHead, original, preparedSha,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  delays = [200, 500, 1000, 2000] }) {
  for (let attempt = 0; ; attempt++) {
    const pr = await readPR();
    if (pr?.state !== 'open' || pr.draft || pr.merged_at || pr.stack ||
        pr.title !== original.title || pr.base?.ref !== original.base.ref ||
        pr.head?.ref !== original.head.ref ||
        pr.head?.repo?.full_name !== original.head.repo.full_name ||
        pr.base?.repo?.full_name !== original.base.repo.full_name) break;
    if (pr.head.sha !== preparedSha && pr.head.sha !== original.head.sha) break;
    if (await readHead() !== preparedSha) break;
    if (pr.head.sha === preparedSha) return pr;
    if (attempt >= delays.length) break;
    await sleep(delays[attempt]);
  }
  throw Error('PR changed after guarded push or GitHub has not confirmed the pushed head; inspect the selected branch before merging.');
}

module.exports = { readPushedPR };
