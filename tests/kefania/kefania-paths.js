'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveKefaniaFile, isKefaniaRemote } = require('../../extension/codex/kefania-paths');
const { readKefaniaInstructions } = require('../../extension/github/pull-request');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-kefania-paths-'));
  const options = { home: path.join(root, 'home'), moduleDirectory: path.join(root, 'extension', 'extension') };
  const file = path.join('src', 'local-pr.js');
  function git(directory, ...args) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  async function checkout(directory, remote = 'https://github.com/pony-factor/kefania-PR.git') {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.writeFile(path.join(directory, file), '// test runner\n');
    await fs.writeFile(path.join(directory, 'PULL_REQUEST.md'), 'Shared canonical PR rules.\n');
    git(directory, 'init');
    git(directory, 'remote', 'add', 'origin', remote);
  }
  try {
    const repository = path.join(root, 'GitHub', 'PDF-magic', 'compiler');
    const shared = path.join(root, 'GitHub', 'pony-factor', 'kefania');
    await checkout(shared);
    assert.equal(await resolveKefaniaFile(repository, file, options), path.join(shared, file));
    assert.equal(await readKefaniaInstructions(repository), 'Shared canonical PR rules.');
    await assert.rejects(fs.access(path.join(root, 'GitHub', 'PDF-magic', 'kefania')), { code: 'ENOENT' });

    const sibling = path.join(root, 'GitHub', 'PDF-magic', 'kefania');
    await checkout(sibling);
    assert.equal(await resolveKefaniaFile(repository, file, options), path.join(sibling, file), 'Preserve explicit sibling checkout precedence');

    const other = path.join(root, 'Documents', 'project');
    const homeShared = path.join(options.home, 'GitHub', 'pony-factor', 'kefania');
    await checkout(homeShared);
    assert.equal(await resolveKefaniaFile(other, file, options), path.join(homeShared, file));
    await fs.rm(homeShared, { recursive: true });
    await assert.rejects(resolveKefaniaFile(other, file, options), /Kefania was not found/);
    const renamedShared = homeShared + '-PR';
    await checkout(renamedShared);
    for (const repositoryPath of [other,
      path.join(root, 'var', 'tmp', 'Sweetiebot', 'project', 'trial-1234-violet', 'project'),
      path.join(root, 'Workspaces', 'project', 'topic-violet', 'project')]) {
      assert.equal(await resolveKefaniaFile(repositoryPath, file, options), path.join(renamedShared, file),
        'Normal, trial and managed workspaces find the renamed shared service');
      assert.equal(await resolveKefaniaFile(repositoryPath, 'PULL_REQUEST.md', options),
        path.join(renamedShared, 'PULL_REQUEST.md'));
    }
    await checkout(homeShared);
    assert.equal(await resolveKefaniaFile(other, file, options), path.join(homeShared, file),
      'Existing kefania checkout precedence is preserved');
    const renamedSibling = path.join(root, 'Documents', 'kefania-PR');
    await checkout(renamedSibling);
    await fs.rm(homeShared, { recursive: true });
    assert.equal(await resolveKefaniaFile(other, file, options), path.join(renamedSibling, file),
      'Renamed sibling takes precedence over renamed shared checkout');
    await assert.rejects(resolveKefaniaFile(other, file, {
      ...options, accessFile: async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); }
    }), /Access denied/, 'Do not silently replace an inaccessible checkout');
    for (const remote of ['https://github.com/pony-factor/kefania-PR.git',
      'git@github.com:pony-factor/kefania.git', 'ssh://git@github.com/pony-factor/kefania-PR.git/']) {
      assert.equal(isKefaniaRemote(remote), true);
    }
    for (const remote of ['https://github.com/someone/kefania-PR.git',
      'https://github.com.evil.example/pony-factor/kefania-PR.git',
      'https://github.com/pony-factor/kefania-PR-extra.git', '/tmp/kefania-PR']) {
      assert.equal(isKefaniaRemote(remote), false);
    }
    await fs.rm(renamedSibling, { recursive: true });
    await fs.rm(renamedShared, { recursive: true });
    const arbitrary = path.join(options.home, 'GitHub', 'services', 'pr-assistant');
    await checkout(arbitrary, 'git@github.com:pony-factor/kefania-PR.git');
    await checkout(homeShared, 'https://github.com/unrelated/project.git');
    for (const repositoryPath of [other,
      path.join(root, 'var', 'tmp', 'Sweetiebot', 'project', 'trial-1234-violet', 'project')]) {
      assert.equal(await resolveKefaniaFile(repositoryPath, file, options), path.join(arbitrary, file),
        'Git identity finds arbitrarily renamed checkouts and rejects a misleading folder name');
    }
    git(arbitrary, 'remote', 'set-url', 'origin', 'https://github.com/unrelated/project.git');
    await assert.rejects(resolveKefaniaFile(other, file, options), /Kefania was not found/,
      'Unrelated repositories are never used');
    git(arbitrary, 'remote', 'set-url', 'origin', 'https://github.com/pony-factor/kefania-PR.git');
    const linked = path.join(options.home, 'GitHub', 'services', 'linked-pr');
    git(arbitrary, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
    git(arbitrary, 'worktree', 'add', '--detach', linked);
    await fs.mkdir(path.join(linked, 'src'));
    await fs.writeFile(path.join(linked, file), '// linked runner\n');
    await fs.rm(path.join(arbitrary, file));
    assert.equal(await resolveKefaniaFile(other, file, options), path.join(linked, file),
      'Linked Git worktrees are supported');
    await fs.rm(path.join(linked, file));
    const nested = path.join(arbitrary, 'nested');
    await fs.mkdir(path.join(nested, 'src'), { recursive: true });
    await fs.writeFile(path.join(nested, file), '// misleading nested runner\n');
    await assert.rejects(resolveKefaniaFile(path.join(arbitrary, 'project'), file, options),
      /Kefania was not found/, 'Nested directories must not inherit a parent Git identity');
    console.log('Kefania shared checkout discovery checks passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
