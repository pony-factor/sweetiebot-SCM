'use strict';

// Shared by manual Lindsey implementation tasks, branch-only syncs, and bulk merges.
function reviewPublicationInstructions() {
  return [
    'GITHUB REVIEW PUBLICATION POLICY: A changed file or resolved textual conflict is not itself an actionable code-review finding. Never create a per-file inline comment to narrate retained edits, patch origins, verification, test status, commit identifiers, or that no decision remains. Do not mark routine integration notes with <!-- sweetiebot-merge-review -->. Put file-by-file conflict rationale in the required decision commit titles/bodies and local handoff record, not in GitHub review threads.',
    'Never post a GitHub PR Conversation comment, review, or summary for a no-op sync, a clean branch-only preparation, or an attempt that did not merge or resolve anything. The local Lindsey status already records unchanged results.',
    'Keep the helpful human-readable overview: for a substantive manual PR synchronization, use at most one concise overall GitHub review body to summarize the net changes, verification actually run, limitations, and any remaining blockers. If the review already has an equivalent overview, do not duplicate it in top-level PR Conversation comments or another review. An automatic merge/batch round does not need a public success or clean-review comment; GitHub state and the Lindsey dashboard already track completion.',
    'Publish an inline code comment ONLY for a concrete unresolved defect needing attention or a genuinely ambiguous human decision with materially different outcomes. Identify the precise changed code, real consequence, supporting evidence, and required action or choices. Inspect existing review threads and deduplicate by actual issue. Only tag truly actionable findings with <!-- sweetiebot-merge-review -->. For selectable decisions include the structured choices required below; never invent choices for compatible integrations. Do not edit a human-authored comment: reply in its existing thread if a material resolution or remaining question warrants it. If no actionable issue remains, publish zero inline comments.'
  ].join('\n\n');
}

module.exports = { reviewPublicationInstructions };
