'use strict';

// GitHub Pull Requests uses pr/<contributor>/<number> for local PR checkouts.
// These are review snapshots, not new user-created topic branches.
function isPullRequestReviewBranch(branch) {
  return typeof branch === 'string'
    && /^pr\/[A-Za-z0-9][A-Za-z0-9-]*\/[1-9]\d*$/.test(branch);
}

module.exports = { isPullRequestReviewBranch };
