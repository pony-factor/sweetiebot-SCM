'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveKefaniaFile } = require('../efs/kefania_paths');
const { readKefaniaInstructions } = require('../efs/pull_request');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-kefania-paths-'));
  const options = { home: path.join(root, 'home'), moduleDirectory: path.join(root, 'extension', 'efs') };
  const file = path.join('src', 'local-pr.js');
  async function checkout(directory) {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.writeFile(path.join(directory, file), '// test runner\n');
    await fs.writeFile(path.join(directory, 'PULL_REQUEST.md'), 'Shared canonical PR rules.\n');
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
    await assert.rejects(resolveKefaniaFile(other, file, {
      ...options, accessFile: async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); }
    }), /Access denied/, 'Do not silently replace an inaccessible checkout');
    console.log('Kefania shared checkout discovery checks passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
