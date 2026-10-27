'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePatchPath } = require('./merge_patch');

function validateDecisions(value = []) {
  if (!Array.isArray(value) || value.length > 50) throw Error('Invalid per-file resolution decisions.');
  const seen = new Set();
  return value.map(item => {
    if (!safePatchPath(item?.path) || seen.has(item.path) ||
        typeof item.title !== 'string' || item.title.length > 160 ||
        !/^\p{Extended_Pictographic}\uFE0F?\s+\S/u.test(item.title) || /[\r\n\x00]/.test(item.title) ||
        typeof item.description !== 'string' || !item.description.trim() || item.description.length > 4000 ||
        /\x00/.test(item.description) || /^Co-authored-by:/im.test(item.description)) {
      throw Error('Each conflicted file needs a unique safe path, emoji decision title and explanation.');
    }
    seen.add(item.path);
    return { path: item.path, title: item.title.trim(), description: item.description.trim() };
  });
}

// Build an append-only PR history in an isolated index. main is only a tree
// source: every new parent chain starts at the selected PR head.
async function createResolutionCommits({ git, directory, headSha, baseSha, finalTree,
  conflicts, decisions, author, base, onCommit = () => {} }) {
  decisions = validateDecisions(decisions);
  if (conflicts.some(file => !safePatchPath(file)) ||
      conflicts.length !== decisions.length || conflicts.some(file => !decisions.some(item => item.path === file))) {
    throw Error('Provide one decision for every actual conflicted file, and no unrelated files.');
  }
  const messageFile = path.join(directory, '.git', 'sweetiebot-resolution-message');
  // commit-tree requires -S explicitly; Git supplies the configured signing key.
  const sign = (await git('config', '--type=bool', '--default', 'false', '--get', 'commit.gpgsign')) === 'true';
  const commit = async (tree, parent, message, incoming) => {
    await fs.writeFile(messageFile, message + '\n', { mode: 0o600 });
    return git('-c', 'user.name=' + author.name, '-c', 'user.email=' + author.email,
      'commit-tree', ...(sign ? ['-S'] : []), tree, '-p', parent,
      ...(incoming ? ['-p', incoming] : []), '-F', messageFile);
  };
  await git('read-tree', headSha);
  let tip = headSha;
  const commits = [];
  for (const decision of decisions) {
    const entry = await git('ls-tree', '-z', finalTree, '--', decision.path);
    if (entry) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0?$/.exec(entry);
      if (!match || match[3] !== decision.path) throw Error('Resolution must use a regular file.');
      await git('update-index', '--add', '--cacheinfo', match[1], match[2], decision.path);
    } else await git('update-index', '--force-remove', '--', decision.path);
    const tree = await git('write-tree');
    const message = decision.title + '\n\n' + decision.description + '\n\nFile: ' + decision.path +
      '\nIncoming ' + base + ': ' + baseSha + '\n\nCo-authored-by: Codex Web <noreply@openai.com>';
    tip = await commit(tree, tip, message);
    commits.push({ ...decision, sha: tip });
    try { onCommit({ ...decision, sha: tip }); } catch { /* Reporting cannot alter the prepared tree. */ }
  }
  // The remaining tree difference contains only nonconflicting incoming work.
  // Keep an empty sync marker if all incoming changes were resolved above.
  tip = await commit(finalTree, tip, '🔄 Sync branch to ' + base +
    '\n\nIncorporate the remaining incoming changes after the per-file conflict decisions.' +
    '\nSource: ' + baseSha + '\n\nCo-authored-by: Codex Web <noreply@openai.com>', baseSha);
  return { sha: tip, commits };
}

module.exports = { validateDecisions, createResolutionCommits };
