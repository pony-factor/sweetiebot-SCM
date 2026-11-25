'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePatchPath } = require('./patch');
const { commitIdentity, attributedCommitTree, verifyLocalCommitIdentity } = require('./commit-signing');
const validTitle = value => typeof value === 'string' && value.length <= 160 &&
  /^\p{Extended_Pictographic}\uFE0F?\s+\S/u.test(value) && !/[\r\n\x00]/.test(value);

function validateDecisions(value = []) {
  if (!Array.isArray(value) || value.length > 512) throw Error('Invalid per-file resolution decisions.');
  const seen = new Set();
  return value.map(item => {
    if (!safePatchPath(item?.path) || seen.has(item.path) ||
        !validTitle(item.title) || (item.groupTitle !== undefined && !validTitle(item.groupTitle)) ||
        typeof item.description !== 'string' || !item.description.trim() || item.description.length > 4000 ||
        /\x00/.test(item.description) || /^Co-authored-by:/im.test(item.description) ||
        (item.keepBase !== undefined && typeof item.keepBase !== 'boolean')) {
      throw Error('Each conflicted file needs a unique safe path, emoji decision title, and explanation.');
    }
    seen.add(item.path);
    return { path: item.path, title: item.title.trim(), description: item.description.trim(),
      ...(item.groupTitle !== undefined ? { groupTitle: item.groupTitle.trim() } : {}),
      ...(item.keepBase ? { keepBase: true } : {}) };
  });
}

// Build an append-only PR history in an isolated index. main is only a tree
// source: every new parent chain starts at the selected PR head.
async function createResolutionCommits({ git, directory, headSha, baseSha, finalTree,
  conflicts, decisions, supportingFiles = [], author, automationCommitter = null, base, onCommit = () => {},
  messageDirectory = path.join(directory, '.git'), preserveMergeAncestry = true,
  createCommitTree = attributedCommitTree }) {
  decisions = validateDecisions(decisions);
  if (conflicts.some(file => !safePatchPath(file) || !decisions.some(item => item.path === file)) ||
      decisions.some(item => !conflicts.includes(item.path) && !supportingFiles.includes(item.path))) {
    throw Error('Provide one decision for every actual conflicted file, and no unrelated files.');
  }
  const messageFile = path.join(messageDirectory, 'sweetiebot-resolution-message');
  const identity = await commitIdentity(git, author, false, false, automationCommitter);
  const commit = async (tree, parent, message, incoming) => {
    const parentTree = await git('rev-parse', parent + '^{tree}');
    if (tree === parentTree) throw Error('Refusing an empty Lindsey commit.');
    await fs.writeFile(messageFile, message + '\n', { mode: 0o600 });
    const sha = await createCommitTree({ directory, tree, parents: incoming ? [parent, incoming] : [parent],
      messageFile, identity });
    if (await git('rev-parse', sha + '^{tree}') !== tree ||
        await git('show', '-s', '--format=%P', sha) !== [parent, ...(incoming ? [incoming] : [])].join(' ')) {
      throw Error('Lindsey commit does not contain the intended changed tree and parents.');
    }
    await verifyLocalCommitIdentity(git, sha, identity);
    return sha;
  };
  await git('read-tree', headSha);
  let currentTree = await git('write-tree');
  // No substantive change relative to the selected PR head means no commit,
  // even if a merge marker could record additional ancestry.
  if (finalTree === currentTree) return { sha: headSha, commits: [], unchanged: true };
  let tip = headSha;
  const commits = [];
  // Group by semantic repair title, not file type or directory. Legacy decisions
  // remain valid; identical titles naturally share a commit.
  const groups = new Map();
  for (const decision of decisions) {
    const title = decision.groupTitle || decision.title;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(decision);
  }
  for (const [title, group] of groups) {
    const changed = [];
    let stagedTree = currentTree;
    for (const decision of group) {
      const entry = await git('ls-tree', '-z', finalTree, '--', decision.path);
      if (entry) {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0?$/.exec(entry);
        if (!match || match[3] !== decision.path) throw Error('Resolution must use a regular file.');
        await git('update-index', '--add', '--cacheinfo', match[1], match[2], decision.path);
      } else await git('update-index', '--force-remove', '--', decision.path);
      const nextTree = await git('write-tree');
      if (nextTree !== stagedTree) changed.push(decision.path);
      stagedTree = nextTree;
    }
    // An unchanged alias or keepBase decision is evidence, not a new commit.
    if (stagedTree === currentTree) continue;
    const description = group.length === 1 ? group[0].description :
      group.map(decision => decision.path + ' — ' + decision.title + '\n' + decision.description).join('\n\n');
    // If this category completes the final tree, it is the last substantive
    // commit. Record incoming ancestry here rather than adding an empty marker.
    tip = await commit(stagedTree, tip, title + '\n\n' + description,
      preserveMergeAncestry && stagedTree === finalTree ? baseSha : undefined);
    currentTree = stagedTree;
    const entry = { ...(group.length === 1 ? group[0] : {}), title, description,
      paths: changed, decisions: group, sha: tip };
    commits.push(entry);
    try { onCommit(entry); } catch { /* Reporting cannot alter the prepared tree. */ }
  }
  // A separate sync is warranted only by remaining substantive changes.
  if (finalTree !== currentTree) {
    tip = await commit(finalTree, tip, '🔄 Sync branch to ' + base, preserveMergeAncestry ? baseSha : undefined);
  }
  return { sha: tip, commits };
}

module.exports = { validateDecisions, createResolutionCommits };
