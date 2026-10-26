# Pull requests, Kefania, Lindsey and review safety

## Creation and publication

**New PR** starts a dedicated Sweetiebot PR workspace and ChatGPT drafting/research flow. The local **Kefania** runner supplies repository context, diff, actual head/base, and publication handoff. Opening a chat or creating a draft does **not** itself create a remote PR. `scmToolkit.autoPublishPullRequests` defaults to `true` in the manifest for **completed eligible drafts**; local settings and successful authorization control whether publishing actually happens. Optional independent pony-profile research is separate from PR description drafting.

PR opener, Git commit author/committer, co-author trailer and review commenter may be different identities. See [distinct GitHub App setup](distinct-github-apps.md).

## Merging and blockers

**Squash and Merge**, **Merge All**, and selected batch actions use guarded GitHub/Kefania/Lindsey surfaces. Dashboard selection or submitting a ChatGPT prompt is **not** a verified merge. Recheck every PR's **live head SHA**, **actual base** (not assumed `main`), state, checks, rules, reviews, conflicts, attribution and stack dependencies. Merging an earlier PR can advance another PR's base and invalidate previous checks: reassess before continuing.

The sync-commit filter normally omits routine `Sync brach/branch to main` entries from summaries without discarding legitimate author credits. Conflict repair belongs on the PR's head branch, preserving compatible behavior. A deterministic failing check needs analysis and a targeted fix, not repeated ungrounded reruns. Defer materially ambiguous behavior; do not silently bypass protections.

The optional external Lindsey runner is discovered by [`efs/lindsey_bulk_merge.js`](../efs/lindsey_bulk_merge.js). **There is no local `scripts/bulk-merge.js` in Sweetiebot.** Its remote script and deployment must be managed separately.

## AI reviews and authorization boundaries

**Respond to AI Code Review** selects one unresolved inline thread, waits for a published relevant single-commit change, asks a local model to assess the exact diff, posts a bounded explanation in the **original thread**, then resolves it if substantiated. See [full procedure and safeguards](ai-review-reply.md). A general PR conversation comment is not the same operation.

In optional separate-App mode, Lindsey may read PRs/checks/diffs via a repository-scoped installation token; write operations, merges, pushes and reactions still require appropriately authorized accounts. Missing credentials **fail closed** without impersonation. See [App identity configuration](distinct-github-apps.md).

Source: [PR flow](../efs/pull_request.js), [Kefania runner](../efs/kefania_runner.js), [merge batch](../efs/merge_batch.js), [dashboard](../efs/merge_dashboard.js), [review reply](../efs/ai_review_reply.js). See [troubleshooting](troubleshooting.md).
