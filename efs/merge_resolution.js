'use strict';

const { humanSquashMerge } = require('./local_human_squash');
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
    seen.add(item.number);
    return { number: pr.number, headSha: pr.headSha, baseSha: item.baseSha,
      base: pr.base, head: pr.head, title: pr.title, patch: item.patch, explanation: item.explanation };
  });
}

async function executeResolution(input, selection, { merge = humanSquashMerge, api, git } = {}) {
  // Validate the entire batch before any PR can be changed.
  const items = validateResolution(input, selection);
  const results = [];
  for (const item of items) {
    try {
      const result = await merge(selection.repository, item.number, {
        api, git, expected: item,
        resolutionPatch: item.patch
      });
      results.push({ number: item.number, status: result.merged ? 'merged' : result.status || 'blocked', ...result });
    } catch (error) {
      results.push({ number: item.number, status: 'blocked', reason: error.message });
    }
  }
  return { repository: selection.repository, results };
}

async function invokeResolutionCLI(input, selection, token, runner = promisify(execFile)) {
  validateResolution(input, selection);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-merge-handoff-'));
  try {
    const file = path.join(temporary, 'handoff.json');
    await fs.writeFile(file, JSON.stringify({ input, selection }), { mode: 0o600 });
    const { stdout } = await runner(process.execPath,
      [path.join(__dirname, 'merge_resolution_cli.js'), '--input', file], {
        timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1',
          PATH: [...new Set([...(process.env.PATH || '').split(path.delimiter),
            '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].filter(Boolean).join(path.delimiter) }
      });
    const result = JSON.parse(stdout);
    if (result.repository !== selection.repository || !Array.isArray(result.results) ||
        result.results.length !== input.results.length || result.results.some((item, index) =>
          item.number !== input.results[index].number || !['merged', 'blocked', 'needs_resolution', 'waiting', 'checks_failed'].includes(item.status))) {
      throw Error('Local CLI returned an invalid merge result.');
    }
    return result;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

function resolutionInstructions(selection, callback) {
  return [
    'LOCAL LINDSEY CLI HANDOFF: This workflow has an authenticated local Git executor on the user’s Mac. The web session does not need shell access. For selected bot-opened PRs, delegate the human-author squash to this handoff instead of reporting that local Git is unavailable. Do not separately rewrite or merge a PR that you delegate.',
    'For routine Git integration return patch:null, even if GitHub currently reports an out-of-date or conflicting branch: the CLI first tries an isolated three-way Git merge. If it returns needs_resolution, inspect the named overlapping files, the current base, original PR changes and earlier batch merges; return a COMPLETE git unified diff against the exact current BASE tree. Preserve current base behavior and add the remaining PR features. A routine overlap caused by an earlier selected merge is not a human decision. Do not return shell commands, partial patches, binary files, symlinks, credentials, or secret-bearing files. Ask the user only for a genuinely ambiguous behavior/product choice or an actual capability limitation.',
    'Recheck each delegated PR’s exact head, base branch and base SHA. The selected heads are: ' + JSON.stringify(selection.pullRequests.map(pr => ({ number: pr.number, headSha: pr.headSha, base: pr.base }))) + '. Unrelated head changes require review; the coordinator adopts only heads changed by this batch’s verified local executor. Base advancement is expected: refresh and regenerate a stale patch without asking the user to approve the same selected PR again. For patch:null the local helper independently integrates the current base. Old failing checks on an unintegrated head do not prohibit preparing its current-base resolution: the local CLI runs GitHub checks on the resulting head and will not merge failed or pending checks.',
    'After handling any PRs you can merge directly, return ONE JSON object: {"version":1,"repository":' + JSON.stringify(selection.repository) + ',"results":[{"number":123,"headSha":"40 hexadecimal characters","baseSha":"40 hexadecimal characters","patch":null,"explanation":"what changed and why, including any resolution"}]}. Use a JSON string containing the full diff, including final newline, instead of null when resolving a conflict. Include only selected PRs that need local execution. The CLI will verify attribution from original GitHub commits, apply the exact patch with git apply --check and git apply --index in isolation, guard the push with force-with-lease, and ask GitHub to merge the resulting single human-authored squash commit. Checks and reviews still apply.',
    'If every selected PR is blocked or already handled, return results:[] in that same versioned JSON object. This is a valid no-op; the local CLI must not merge anything. Keep the blocker details in the GitHub report. End with a Markdown link labeled "Apply with Lindsey" to ' + callback + '#result= followed by the percent-encoded JSON object. The complete encoded URL must be under 80000 UTF-8 bytes. Do not truncate a patch to fit. Returning this link authorizes execution for this already-selected merge batch; the local page automatically submits it and displays independently verified results. Before returning, describe delegated PRs as pending local execution, never as merged.'
  ].join('\n\n');
}

module.exports = { validateResolution, executeResolution, invokeResolutionCLI, resolutionInstructions, MAX_PATCH_BYTES };
