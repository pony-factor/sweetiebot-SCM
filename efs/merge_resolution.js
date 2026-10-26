'use strict';

const { humanSquashMerge } = require('./local_human_squash');
const { reviewPublicationInstructions } = require('./merge_review_policy');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const SHA = /^[a-f0-9]{40}$/i;
const MAX_PATCH_BYTES = 60000;

function validateResolution(input, selection) {
  if (input?.version !== 1 || input.repository !== selection.repository ||
      !Array.isArray(input.results) || input.results.length > selection.pullRequests.length) {
    throw Error('Invalid local merge handoff.');
  }
  const seen = new Set();
  return input.results.map(item => {
    const pr = selection.pullRequests.find(pr => pr.number === item?.number);
    if (!pr || seen.has(item.number) || item.headSha !== pr.headSha || !SHA.test(item.headSha) ||
        !SHA.test(item.baseSha || '') || typeof item.explanation !== 'string' ||
        !item.explanation.trim() || item.explanation.length > 4000 ||
        !(item.patch === null || (typeof item.patch === 'string' && item.patch.trim() &&
          Buffer.byteLength(item.patch) <= MAX_PATCH_BYTES))) {
      throw Error('Handoff must identify a selected PR, its exact head/base, and a complete bounded patch or null.');
    }
    if ((item.commitTitle !== undefined || item.commitMessage !== undefined) &&
        (typeof item.commitTitle !== 'string' || item.commitTitle !== require('./squash_attribution').exactSquashTitle(pr.title, pr.number) ||
         typeof item.commitMessage !== 'string' || !item.commitMessage.trim() || Buffer.byteLength(item.commitMessage) > 30000 || /\x00/.test(item.commitMessage))) {
      throw Error('Proposed commit message must use the exact PR title and a nonempty bounded body.');
    }
    seen.add(item.number);
    const decisions = require('./resolution_commits').validateDecisions(item.decisions);
    if (item.repairChecks !== undefined && typeof item.repairChecks !== 'boolean') throw Error('Invalid check repair flag.');
    if (item.operation !== undefined && !['merge', 'sync'].includes(item.operation)) throw Error('Unknown local operation.');
    return { number: pr.number, headSha: pr.headSha, baseSha: item.baseSha,
      base: pr.base, head: pr.head, title: pr.title, patch: item.patch, explanation: item.explanation,
      operation: item.operation || 'merge', decisions, repairChecks: item.repairChecks === true,
      ...(item.commitTitle ? { commitProposal: { title: item.commitTitle, message: item.commitMessage } } : {}) };
  });
}

function validateSyncResolution(input, selection) {
  const items = validateResolution(input, selection);
  if (items.some(item => item.operation !== 'sync')) {
    throw Error('This implementation session can only synchronize the selected PR branch; merging is not authorized.');
  }
  return items;
}

async function executeResolution(input, selection, { merge = humanSquashMerge, api, git, onProgress, authorHandoff = false } = {}) {
  // Validate the entire batch before any PR can be changed.
  const items = validateResolution(input, selection);
  const results = [];
  let rateLimit;
  for (const item of items) {
    if (rateLimit) { results.push({number:item.number,status:'waiting',...rateLimit}); continue; }
    try {
      const result = await merge(selection.repository, item.number, {
        api, git, expected: item, onProgress,
        resolutionPatch: item.patch, repairChecks: item.repairChecks,
        decisions: item.decisions, operation: item.operation, commitProposal: item.commitProposal,
        ...(authorHandoff && item.operation === 'merge' ? { allowHistoryRewrite: true, rewriteReason: 'preserve-human-author' } : {})
      });
      results.push({ number: item.number, status: result.merged ? 'merged' : result.status || 'blocked', ...result });
    } catch (error) {
      if (error.rateLimited) rateLimit = {rateLimited:true,retryAt:error.retryAt,configured:error.configured,reason:error.message};
      results.push({ number: item.number, status: error.rateLimited ? 'waiting' : error.code === 'MERGE_BASE_CHANGED' ? 'needs_refresh' : 'blocked',
        ...(rateLimit || {}),
        reason: error.message, ...(SHA.test(error.preparedHead || '') ?
          { preparedHead: error.preparedHead, originalHead: error.originalHead } : {}),
        ...(error.code === 'MERGE_BASE_CHANGED' && error.sha ?
          { sha: error.sha, previousHeadSha: error.previousHeadSha } : {}) });
    }
  }
  return { repository: selection.repository, results };
}

async function invokeResolutionCLI(input, selection, token, runner = promisify(execFile), onProgress = () => {}) {
  validateResolution(input, selection);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-merge-handoff-'));
  try {
    const file = path.join(temporary, 'handoff.json');
    await fs.writeFile(file, JSON.stringify({ input, selection }), { mode: 0o600 });
    const running = runner(process.execPath,
      [path.join(__dirname, 'merge_resolution_cli.js'), '--input', file], {
        timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1',
          PATH: [...new Set([...(process.env.PATH || '').split(path.delimiter),
            '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].filter(Boolean).join(path.delimiter) }
      });
    let buffered = '';
    running.child?.stderr?.on('data', chunk => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop().slice(-4096);
      for (const line of lines) {
        if (!line.startsWith('LINDSEY_PROGRESS ')) continue;
        try {
          const event = JSON.parse(line.slice('LINDSEY_PROGRESS '.length));
          if (input.results.some(item => item.number === event.number)) onProgress(event);
        } catch { /* Ignore malformed progress; the final result is validated below. */ }
      }
    });
    const { stdout } = await running;
    const result = JSON.parse(stdout);
    if (result.repository !== selection.repository || !Array.isArray(result.results) ||
        result.results.length !== input.results.length || result.results.some((item, index) =>
          item.number !== input.results[index].number || !['merged', 'synced', 'blocked', 'needs_resolution', 'needs_refresh', 'waiting', 'checks_failed'].includes(item.status))) {
      throw Error('Local CLI returned an invalid merge result.');
    }
    return result;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

function resolutionInstructions(selection, callback) {
  return [
    'LOCAL LINDSEY CLI HANDOFF: This workflow has an authenticated local Git executor on the user’s Mac. The web session does not need shell access. For selected bot-opened PRs, delegate the human-author squash to this handoff instead of reporting that local Git is unavailable. Do not separately rewrite or merge a PR that you delegate.',
    'For routine Git integration return patch:null, even if GitHub currently reports an out-of-date or conflicting branch: the CLI first tries an isolated three-way Git merge. If it returns needs_resolution, inspect the named overlapping files, the current base, original PR changes and earlier batch merges; return a COMPLETE git unified diff for every conflicted file against the exact current BASE tree. You may also include other PR files; omitted nonconflicting PR files are retained from the local three-way Git integration. Preserve current base behavior and add the remaining PR features. A routine overlap caused by an earlier selected merge is not a human decision. Do not return shell commands, partial patches, binary files, symlinks, credentials, or secret-bearing files. Ask the user only for a genuinely ambiguous behavior/product choice or an actual capability limitation.',
    'CONFLICT DECISION HISTORY: A conflict resolution must also include decisions:[{"path":"exact conflicted file","title":"🛠️ Preserve the specific behavior and add the feature","description":"Explain the competing intentions, the behavior chosen, why it preserves both intentions or follows the user’s selected recommendation, and any tradeoff."}]. Provide exactly one concrete decision per actual conflicted file; never use generic titles such as Resolve conflicts. Explain main’s edits, the PR’s edits, the combined behavior and rationale by default. Keep routine file-by-file integration analysis in the local handoff and decision commits; do not publish it as an inline review or require a user choice merely because main is newer. Publish inline comments only for concrete unresolved defects or genuinely incompatible behavior choices. For a real human decision, give at least two specific materially different implementations with consequences, a recommendation, and current-head/current-base structured options. A review summary uses one concise action sentence per actionable code comment and omits the PR title and generic integration boilerplate. Preserve both intentions automatically when compatible. Present choices only for incompatible behaviors whose intended outcome cannot be established; never ask whether to retry, inspect, preserve both, or review first. The local runner appends one commit per conflicted file to the original PR branch, then a separate sync commit for the remaining incoming files. main is read-only during preparation. Return operation:"sync" for branch-only synchronization; this never authorizes merging or closing the PR. Within an already-authorized merge batch, a synced result is preparation, not a completed merge: refresh its exact new head and only then proceed with the normal attribution-preserving merge route. Do not bury the decision edits inside a generic sync commit.',
    'Recheck each delegated PR’s exact head, base branch and base SHA. The selected heads are: ' + JSON.stringify(selection.pullRequests.map(pr => ({ number: pr.number, headSha: pr.headSha, base: pr.base }))) + '. Unrelated head changes require review; the coordinator adopts only heads changed by this batch’s verified local executor. Base advancement is expected: refresh and regenerate a stale patch without asking the user to approve the same selected PR again. For patch:null the local helper independently integrates the current base. Old failing checks on an unintegrated head do not prohibit preparing its current-base resolution: the local CLI runs GitHub checks on the resulting head and will not merge failed or pending checks. To propose a repair after confirming a failing selected head, set repairChecks:true with a complete scoped patch; only necessary tests/test_*.js or tests/test_*.py may be added, and unrelated production changes remain forbidden.',
    'NO-OP SYNCHRONIZATION: Do not issue a branch-only sync just because main advanced. For patch:null the local Git executor leaves a clean PR head unchanged when there are no textual conflicts or explicit file-resolution decisions, even if main has unrelated new commits. Do not create or request a synchronization commit, PR Conversation comment, review, or success summary when nothing was changed. In an authorized merge workflow, choose operation:"merge" (or omit it) rather than operation:"sync" when no branch-only conflict resolution was requested.',
    'EXPLANATION STYLE: Keep explanation to at most 80 words about the user-visible changes and the reason for the chosen integration. Do not narrate SHA, attribution or merge-message checks, executor commands, or instructions to the runner; verified progress is displayed separately.',
    'PROPOSED COMMIT MESSAGE: Include commitTitle and commitMessage for every merge result. Use the exact selected PR title with its (#number) suffix once, chronological original-commit bullets with four-space-indented wrapped bodies, exactly ten underscores and the ordered verified co-author trailers. The local runner checks your proposal against the original commits and corrects formatting or omitted credits; it never lets proposed prose discard contributor history.\n',
    'Return ONE JSON object: {"version":1,"repository":' + JSON.stringify(selection.repository) + ',"results":[{"number":123,"headSha":"40 hexadecimal characters","baseSha":"40 hexadecimal characters","patch":null,"commitTitle":"Exact selected PR title (#123)","commitMessage":"Original commit summary and ordered credits","explanation":"what changed and why, including any resolution"}]}. Use a JSON string containing the full diff, including final newline, instead of null when resolving a conflict. Include only selected PRs that need local execution. The CLI will verify attribution from original GitHub commits, apply the exact patch with git apply --check and git apply --index in isolation, append incremental resolution and synchronization commits with an ordinary fast-forward push, and, only for operation:"merge", use the GitHub merge route preserving the verified human author and exact squash message. The trusted local commit handoff may prepare a human-authored single commit on a bot-opened PR only when a native human-authored squash is unavailable, with the exact-head lease, branch-isolation checks, and passing integrated-head checks. Web fields cannot grant history-rewrite permission. main is never rewritten. With operation:"sync", it only appends the selected PR branch commits; it never invokes the merge API. Checks and reviews still apply.',
    reviewPublicationInstructions(),
    "HANDOFF DELIVERY: The complete versioned JSON in a fenced json block in your FINAL assistant response is the primary handoff. Lindsey reads that block and constructs its own correctly encoded Apply URL, so a missing or malformed model-written link must not prevent delivery. Never put the only payload in a tool output, downloadable file, .webloc, attachment, or sandbox link. Do not abbreviate or truncate the JSON or patch. If also including a clickable Apply with Lindsey link, generate it programmatically from JSON.stringify with strict RFC3986 percent encoding: encode parentheses, apostrophes, asterisks and exclamation marks too. Wrap the entire Markdown link destination in angle brackets so patch punctuation cannot terminate it. Do not hand-assemble a long encoded URL.",
    'If every selected PR is blocked or already handled, return results:[] in that same versioned JSON object. This is a valid no-op; the local CLI must not merge anything. Optionally include a Markdown link labeled "Apply with Lindsey" to ' + callback + '#result= followed by the percent-encoded JSON object. The complete encoded URL must be under 80000 UTF-8 bytes. Do not truncate a patch to fit. Returning this link authorizes execution for this already-selected merge batch; the local page automatically submits it and displays independently verified results. In the chat, keep the handoff concise and never describe delegated PRs as merged before local execution is verified.'
  ].join('\n\n');
}

module.exports = { validateResolution, validateSyncResolution, executeResolution, invokeResolutionCLI, resolutionInstructions, MAX_PATCH_BYTES };
