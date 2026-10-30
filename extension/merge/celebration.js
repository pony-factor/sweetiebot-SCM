'use strict';

// Queue completion is not proof of a successful merge. Reject empty and
// partially loaded selections until every selected PR has confirmed merge state.
function allPullRequestsMerged(prs) {
  return Array.isArray(prs) && prs.length > 0 &&
    prs.every(pr => pr?.state === 'merged');
}

module.exports = { allPullRequestsMerged };
