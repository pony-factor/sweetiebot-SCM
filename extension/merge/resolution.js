'use strict';

const { humanSquashMerge } = require('./local_human_squash');
const { reviewPublicationInstructions } = require('./review_policy');
const { reportOptionsInstructions } = require('./blocker_actions');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateResolutionHunks } = require('./conflict_hunks');
const SHA = /^[a-f0-9]{40}$/i;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;

function validateResolution(input, selection) {
  if (input?.version !== 1 || input.repository !== selection.repository ||
      !Array.isArray(input.results) || input.results.length > selection.pullRequests.length) {
    throw Error('Invalid local merge handoff.');
  }
  const seen = new Set();
  return input.results.map(item => {
    const pr = selection.pullRequests.find(pr => pr.number === item?.number);
    const resolutionHunks = validateResolutionHunks(item?.resolutionHunks);
    if (resolutionHunks.length && item.patch !== null)
      throw Error('Choose a full patch OR compact Git conflict hunks, never both.');
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
    if (resolutionHunks.length && (decisions.length !== resolutionHunks.length ||
        resolutionHunks.some(file => !decisions.some(item => item.path === file.path)))) {
      throw Error('Each compact conflicted file requires one concrete conflict decision.');
    }
    if (item.repairChecks !== undefined && typeof item.repairChecks !== 'boolean') throw Error('Invalid check repair flag.');
    if (item.operation !== undefined && !['merge', 'sync'].includes(item.operation)) throw Error('Unknown local operation.');
    return { number: pr.number, headSha: pr.headSha, baseSha: item.baseSha,
      base: pr.base, head: pr.head, title: pr.title, patch: item.patch, resolutionHunks,
      explanation: item.explanation,
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
        resolutionPatch: item.patch, resolutionHunks: item.resolutionHunks, repairChecks: item.repairChecks,
        decisions: item.decisions, operation: item.operation, commitProposal: item.commitProposal,
        localGitMerge: item.operation === 'merge'
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
      [path.join(__dirname, 'resolution_cli.js'), '--input', file], {
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
      buffered = lines.pop().slice(-16384);
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
    'CONFLICT DECISION HISTORY: A conflict resolution must also include decisions:[{"path":"exact conflicted file","title":"🛠️ Preserve the specific behavior and add the feature","description":"Explain the competing intentions, the behavior chosen, why it preserves both intentions or follows the user’s selected recommendation, and any tradeoff."}]. Provide exactly one concrete decision per actual conflicted file; never use generic titles such as Resolve conflicts. Explain main’s edits, the PR’s edits, the combined behavior and rationale by default. Keep routine file-by-file integration analysis in the local handoff and decision commits; do not publish it as an inline review or require a user choice merely because main is newer. Group substantive repair explanations and any unresolved findings as inline comments on the changed code within one comprehensive PR review with a short summary of the net changes; follow the shared review publication policy below. For a real human decision, give at least two specific materially different implementations with consequences, a recommendation, and current-head/current-base structured options. The review body briefly summarizes the changes covered by its inline comments and omits the PR title and generic integration boilerplate. Preserve both intentions automatically when compatible. Present choices only for incompatible behaviors whose intended outcome cannot be established; never ask whether to retry, inspect, preserve both, or review first. The local runner appends one commit per conflicted file to the original PR branch, then a separate sync commit for the remaining incoming files. main is read-only during preparation. Return operation:"sync" for branch-only synchronization; this never authorizes merging or closing the PR. Within an already-authorized merge batch, a synced result is preparation, not a completed merge: refresh its exact new head and only then proceed with the normal attribution-preserving merge route. Do not bury the decision edits inside a generic sync commit.',
    'Recheck each delegated PR’s exact head, base branch and base SHA. The selected heads are: ' + JSON.stringify(selection.pullRequests.map(pr => ({ number: pr.number, headSha: pr.headSha, base: pr.base }))) + '. Unrelated head changes require review; the coordinator adopts only heads changed by this batch’s verified local executor. Base advancement is expected: refresh and regenerate a stale patch without asking the user to approve the same selected PR again. For patch:null the local helper independently integrates the current base. Old failing checks on an unintegrated head do not prohibit preparing its current-base resolution: the local CLI runs GitHub checks on the resulting head and will not merge failed or pending checks. To propose a repair after confirming a failing selected head, set repairChecks:true with a complete scoped patch; only necessary tests/test_*.js or tests/test_*.py may be added, and unrelated production changes remain forbidden.',
    'NO-OP SYNCHRONIZATION: Do not issue a branch-only sync just because main advanced. For patch:null the local Git executor leaves a clean PR head unchanged when there are no textual conflicts or explicit file-resolution decisions, even if main has unrelated new commits. Do not create or request a synchronization commit, PR Conversation comment, review, or success summary when nothing was changed. In an authorized merge workflow, choose operation:"merge" (or omit it) rather than operation:"sync" when no branch-only conflict resolution was requested.',
    'EXPLANATION STYLE: Keep explanation to at most 80 words about the user-visible changes and the reason for the chosen integration. Do not narrate SHA, attribution or merge-message checks, executor commands, or instructions to the runner; verified progress is displayed separately.',
    'PROPOSED COMMIT MESSAGE: Include commitTitle and commitMessage for every merge result. Use the exact selected PR title with its (#number) suffix once, chronological original-commit bullets with four-space-indented wrapped bodies, exactly ten underscores and the ordered verified co-author trailers. The local runner checks your proposal against the original commits and corrects formatting or omitted credits; it never lets proposed prose discard contributor history.\n',
    'RESOLUTION PAYLOAD: Internally prepare the complete versioned JSON object {"version":1,"repository":' + JSON.stringify(selection.repository) + ',"results":[{"number":123,"headSha":"40 hexadecimal characters","baseSha":"40 hexadecimal characters","patch":null,"resolutionHunks":[],"decisions":[],"commitTitle":"Exact selected PR title (#123)","commitMessage":"Original commit summary and ordered credits","explanation":"what changed and why, including any resolution"}]}. Prefer patch:null and omit resolutionHunks for routine clean integration. BULK CONFLICT RESOLUTION: Prefer compact resolutionHunks for actual conflicting files instead of a huge unified diff: set patch:null, resolutionHunks:[{"path":"verified relative file","hunks":[{"index":0,"choice":"ours|theirs|both-ours-first|both-theirs-first|custom","resolved":"only for custom"}]}], plus one decision per conflicted file. Indexes are zero-based ordered Git conflict regions; ours is current BASE and theirs is the PR HEAD. Use custom to specify just the complete replacement for that region. Optionally include exact ours and theirs to verify a hunk; NEVER guess. The isolated Git executor performs the actual three-way merge locally, preserves nonconflicting edits, applies every specified conflict resolution, rejects missing or changed hunks, and validates the full integrated tree. No entire diff is required. Full unified diff patches remain available where a compact hunk cannot express the change. These two forms are mutually exclusive. Never truncate any patch or hunk; a 32 MiB text patch safety bound does not require the diff to appear in chat. No raw JSON is output unless the browser requests its second and final fallback.',
    'BOT-OPENED PR ATTRIBUTION: For bot-opened PRs, the trusted local handoff can prepare a human-authored integration commit preserving both original parents, make an ordinary fast-forward destination push, and verify GitHub marks the original PR merged. Never rewrite the original PR head, force-push a base branch, or bypass branch-protection rules. Preserve checks and reviews before merging.',
    reviewPublicationInstructions(),
    reportOptionsInstructions(),
    'HANDOFF DELIVERY: The PRIMARY and mandatory final result is exactly one clickable Markdown link labeled "Apply with Lindsey", targeting the authorized callback with #result_gz= followed by URL-safe unpadded Base64 of gzip-compressed UTF-8 JSON.stringify of the complete versioned resolution object. Use a Python or JavaScript execution tool to serialize, gzip and Base64URL-encode the actual JSON bytes; never attempt to invent compressed bytes. Serialize and compress only once; build the full encoded link without hand-escaping or splitting the bytes, and let the local receiver independently verify and decode the payload. Wrap the complete Markdown destination in angle brackets. Return a short explanation beside the link, but DO NOT render a JSON block or raw diff in the normal response. If the button cannot be formed completely, do not truncate it; the Sweetiebot browser will request one automatic retry. Only after that retry fails may the browser request a complete fenced json block as a last-resort fallback. Always preserve full patches; the local runner validates and applies them. The callback is scoped, temporary and single-use.',
    'Apply with Lindsey destination: ' + callback + '#result_gz=<GZIP_BASE64URL>. Use this normal route for every complete link under 80000 UTF-8 bytes. RARE OVERSIZE LAST RESORT ONLY: If (and only if) the complete compressed URL exceeds that budget, compute SHA-256 of the SAME gzip bytes and instead output [Apply with Lindsey](<' + callback + '#result_id=<64hex SHA256>>), followed by a collapsed HTML <details><summary>Compressed transport (only needed for local recovery)</summary> containing a fenced text block with one line SWEETIEBOT_HANDOFF_GZIP_V1:<COMPLETE_BASE64URL>, then close </details>. The scoped browser preload verifies the digest, stages the bytes locally, and enables the short link; it never sends or stores the raw diff remotely. Never use this for ordinarily sized links. The final visible answer should contain only the compact Apply link and a brief explanation; no expanded JSON or diff. If the compressed payload cannot fit even in a complete answer, report that limitation; never truncate. The full JSON must include version:1, repository, results, exact headSha/baseSha, complete patch or null, decisions when applicable, proposal and explanation. For a no-op encode results:[]. Only on an explicitly requested SECOND fallback may raw JSON be printed.'
  ].join('\n\n');
}

module.exports = { validateResolution, validateSyncResolution, executeResolution, invokeResolutionCLI, resolutionInstructions, MAX_PATCH_BYTES };
