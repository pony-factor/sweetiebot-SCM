'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { commitIdentity, attributedCommitTree, verifyLocalCommitIdentity } = require('../../extension/merge/commit-signing');
const { createResolutionCommits } = require('../../extension/merge/resolution-commits');

async function test() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lindsey-signing-identity-'));
  const repo = path.join(root, 'repo');
  const original = { name: 'Original PR Author', email: 'original@users.noreply.github.com' };
  const signer = { name: 'Local Signer', email: 'signer@example.test' };
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, 'signing_key')]);
    const publicKey = (await fs.readFile(path.join(root, 'signing_key.pub'), 'utf8')).trim();
    const allowed = path.join(root, 'allowed-signers');
    await fs.writeFile(allowed, signer.email + ' ' + publicKey + '\n');
    const config = path.join(root, 'gitconfig');
    await fs.writeFile(config, '[user]\n  name = ' + signer.name +
      '\n  email = ' + signer.email + '\n  signingkey = ' + path.join(root, 'signing_key') +
      '\n[commit]\n  gpgsign = true\n[gpg]\n  format = ssh\n[gpg "ssh"]\n  allowedSignersFile = ' + allowed + '\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    await fs.mkdir(repo);
    const git = async (...args) => (await run('git', ['-C', repo, ...args], { env: process.env })).stdout.trim();
    await git('init', '--quiet', '--initial-branch=main');
    await fs.writeFile(path.join(repo, 'file.txt'), 'Base\n');
    await git('add', 'file.txt');
    await git('commit', '--quiet', '-m', 'Base');
    const base = await git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'file.txt'), 'Feature\n');
    await git('add', 'file.txt');
    const tree = await git('write-tree');
    const identity = await commitIdentity(git, original);
    assert.deepEqual(identity.author, original);
    assert.deepEqual(identity.committer, signer);
    const bot = { name: 'Verified App[bot]', email: '123+Verified-App[bot]@users.noreply.github.com' };
    const botIdentity = await commitIdentity(git, original, true, false, bot);
    assert.deepEqual(botIdentity.author, original);
    assert.deepEqual(botIdentity.committer, bot);
    assert.equal(botIdentity.signed, true);
    assert.equal(identity.signed, true);
    const messageFile = path.join(root, 'message');
    await fs.writeFile(messageFile, '🔩 Preserve original author and local committer\n');
    const sha = await attributedCommitTree({ directory: repo, tree, parents: [base], messageFile, identity });
    await verifyLocalCommitIdentity(git, sha, identity);
    assert.equal(await git('show', '-s', '--format=%an <%ae>', sha), original.name + ' <' + original.email + '>');
    assert.equal(await git('show', '-s', '--format=%cn <%ce>', sha), signer.name + ' <' + signer.email + '>');
    await git('verify-commit', sha);
    // A GitHub-verified SSH signature need not have a local allowed-signers
    // trust file. Only local verification is skipped in that case.
    await git('config', '--local', 'gpg.ssh.allowedSignersFile', '');
    await verifyLocalCommitIdentity(git, sha, identity);
    await git('config', '--local', '--unset', 'gpg.ssh.allowedSignersFile');

    // The bulk-resolution path must use the same committer without rewriting
    // the Git author, including when it appends a routine integration marker.
    const resolution = await createResolutionCommits({
      git, directory: repo, headSha: base, baseSha: sha, finalTree: tree,
      conflicts: [], decisions: [], author: original, base: 'main'
    });
    assert.equal(await git('show', '-s', '--format=%an <%ae>', resolution.sha),
      original.name + ' <' + original.email + '>');
    assert.equal(await git('show', '-s', '--format=%cn <%ce>', resolution.sha),
      signer.name + ' <' + signer.email + '>');
    await git('verify-commit', resolution.sha);

    // A category can span source, tests, and unchanged rename aliases. Verify
    // that only changed categories create signed commits, and that the final
    // merge retains the exact intended tree and incoming ancestry.
    await git('read-tree', base);
    await fs.writeFile(path.join(repo, 'file.txt'), 'Combined implementation\n');
    await fs.writeFile(path.join(repo, 'test.txt'), 'Related regression\n');
    await fs.writeFile(path.join(repo, 'docs.txt'), 'Independent documentation\n');
    await fs.writeFile(path.join(repo, 'upstream.txt'), 'Remaining incoming change\n');
    await git('add', '.');
    const groupedTree = await git('write-tree');
    const groupTitle = '🐝 Integrate implementation and regression';
    const decisions = [
      { path: 'file.txt', groupTitle, title: '🐝 Reconcile implementation', description: 'Preserve both features.' },
      { path: 'docs.txt', title: '🖋️ Explain independent documentation', description: 'Describe the separate change.' },
      { path: 'test.txt', groupTitle, title: '🧪 Cover the behavior', description: 'Test the combined implementation.' },
      { path: 'absent.txt', groupTitle, title: '🗑️ Keep retired alias absent', description: 'Neither tree needs this path.' },
      { path: 'unused.txt', title: '🗑️ Keep unused path absent', description: 'No change is required.' }
    ];
    const progress = [];
    const grouped = await createResolutionCommits({ git, directory: repo, headSha: base,
      baseSha: sha, finalTree: groupedTree, conflicts: decisions.map(item => item.path),
      decisions, author: original, base: 'main', onCommit: item => progress.push(item) });
    assert.equal(grouped.commits.length, 2);
    assert.equal(progress.length, 2);
    assert.deepEqual(grouped.commits[0].paths, ['file.txt', 'test.txt']);
    assert.equal(grouped.commits[0].title, groupTitle);
    assert.equal(grouped.commits[0].decisions.length, 3);
    assert.equal(await git('show', '-s', '--format=%B', grouped.commits[0].sha),
      groupTitle + '\n\nPreserve both features.\n\nTest the combined implementation.');
    assert.equal(progress[0].decisions.at(-1).description, 'Neither tree needs this path.');
    assert.equal(await git('rev-list', '--first-parent', '--count', base + '..' + grouped.sha), '3');
    for (const item of grouped.commits) {
      assert.notEqual(await git('rev-parse', item.sha + '^{tree}'), await git('rev-parse', item.sha + '^1^{tree}'));
      await git('verify-commit', item.sha);
    }
    assert.equal(await git('rev-parse', grouped.sha + '^{tree}'), groupedTree);
    assert.equal(await git('rev-parse', grouped.sha + '^2'), sha);
    assert.notEqual(await git('rev-parse', grouped.sha + '^{tree}'), await git('rev-parse', grouped.sha + '^1^{tree}'));
    const groupDescription = 'Preserve both features and cover their combined behavior with a regression test.';
    const completeDecisions = [{ ...decisions[0], groupDescription }, ...decisions.slice(1), { path: 'upstream.txt',
      title: '🔩 Preserve incoming work', description: 'Include the remaining upstream change.' }];
    const complete = await createResolutionCommits({ git, directory: repo, headSha: base,
      baseSha: sha, finalTree: groupedTree, conflicts: completeDecisions.map(item => item.path),
      decisions: completeDecisions, author: original, base: 'main' });
    assert.equal(complete.commits.length, 3);
    assert.equal(await git('show', '-s', '--format=%B', complete.commits[0].sha), groupTitle + '\n\n' + groupDescription);
    assert.equal(await git('show', '-s', '--format=%B', complete.commits[1].sha),
      '🖋️ Explain independent documentation\n\nDescribe the separate change.');
    assert.equal(complete.sha, complete.commits.at(-1).sha, 'Last substantive category records merge ancestry');
    assert.equal(await git('rev-parse', complete.sha + '^2'), sha);
    assert.equal(await git('rev-parse', complete.sha + '^{tree}'), groupedTree);
    assert.equal(await git('rev-list', '--first-parent', '--count', base + '..' + complete.sha), '3');
    for (const item of complete.commits) {
      assert.notEqual(await git('rev-parse', item.sha + '^{tree}'), await git('rev-parse', item.sha + '^1^{tree}'));
      await git('verify-commit', item.sha);
    }
    const unchanged = await createResolutionCommits({ git, directory: repo, headSha: base,
      baseSha: sha, finalTree: await git('rev-parse', base + '^{tree}'),
      conflicts: [], decisions: [], author: original, base: 'main',
      createCommitTree: async () => { throw Error('An unchanged tree must not reach commit-tree'); } });
    assert.deepEqual(unchanged, { sha: base, commits: [], unchanged: true });
    assert.throws(() => require('../../extension/merge/resolution-commits').validateDecisions([
      { ...decisions[0], groupTitle: 'invalid\nheader' }
    ]), /Resolution decision 1 groupTitle must have a nonempty subject, no line breaks or NUL characters/);

    await git('config', '--local', 'commit.gpgsign', 'false');
    const unsigned = await commitIdentity(git, original);
    assert.equal(unsigned.signed, false);
    assert.deepEqual(unsigned.committer, original, 'Unsigned commits retain their existing attribution');
    const unsignedBot = await commitIdentity(git, original, false, false, bot);
    assert.equal(unsignedBot.signed, false);
    assert.deepEqual(unsignedBot.committer, bot, 'Automation attribution persists in unsigned integration');
    const preferred = await commitIdentity(git, original, false, true);
    assert.equal(preferred.signed, true, 'Merge replacements attempt signing with commit.gpgsign=false');
    assert.deepEqual(preferred.committer, signer, 'Signing uses the configured local committer');
    const unsignedSha = await attributedCommitTree({
      directory: repo, tree, parents: [sha], messageFile, identity: unsigned
    });
    await verifyLocalCommitIdentity(git, unsignedSha, unsigned);
    assert(!/(?:^|\n)gpgsig /.test(await git('cat-file', '-p', unsignedSha)));

    await assert.rejects(commitIdentity(async (...args) => args.at(-1) === 'user.email' ? '' :
      args.at(-1) === 'user.name' ? signer.name : 'false', original, true),
    /valid local Git committer/);
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await fs.rm(root, { recursive: true, force: true });
  }
}
test().then(() => console.log('Lindsey merge and bulk-sync commits preserve Git authors and sign with local committers.'))
  .catch(error => { console.error(error); process.exitCode = 1; });
