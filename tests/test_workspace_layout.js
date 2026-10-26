'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceDirectory, workspaceFileName, isWorkspaceDirectory } =
  require('../efs/branches/workspace_layout');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-workspace-layout-'));
  try {
    const base = path.join(temp, 'Workspaces');
    const randomIndex = () => 4; // coral
    const options = { branch: 'feature/nested-task', randomIndex };
    const first = await createWorkspaceDirectory(base, 'pony', fs, options);
    assert.equal(path.basename(first), 'feature-nested-task-coral');
    assert.equal(workspaceFileName(first), 'feature-nested-task-coral.code-workspace');
    assert.equal(await isWorkspaceDirectory(fs, first, base), true);

    const second = await createWorkspaceDirectory(base, 'pony', fs, options);
    assert.equal(path.basename(second), 'feature-nested-task-2-coral');
    assert.notEqual(first, second, 'An existing workspace is never reused');

    // Simultaneous requests cannot both claim the same folder.
    const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
      createWorkspaceDirectory(base, 'pony', fs, options)));
    assert.equal(new Set(concurrent).size, concurrent.length);
    for (const directory of concurrent) {
      assert.match(path.basename(directory), /^feature-nested-task-(?:[2-9]-)?coral$/);
      assert.equal((await fs.lstat(directory)).isDirectory(), true);
    }
    const main = await createWorkspaceDirectory(base, 'pony', fs, { randomIndex });
    assert.equal(path.basename(main), 'main-coral');

    // A colliding file must also be preserved (mkdir rejects EEXIST).
    const occupied = path.join(base, 'pony', 'topic-coral');
    await fs.writeFile(occupied, 'personal file');
    const afterFile = await createWorkspaceDirectory(base, 'pony', fs,
      { branch: 'topic', randomIndex });
    assert.equal(path.basename(afterFile), 'topic-2-coral');
    assert.equal(await fs.readFile(occupied, 'utf8'), 'personal file');

    const escaped = await createWorkspaceDirectory(base, 'pony', fs,
      { branch: '../unsafe/branch', randomIndex });
    assert.equal(path.basename(escaped), 'unsafe-branch-coral');
    assert.equal(path.dirname(escaped), path.join(base, 'pony'));

    await fs.symlink(path.join(base, 'pony'), path.join(base, 'unsafe'));
    await assert.rejects(
      createWorkspaceDirectory(base, 'unsafe', fs, { branch: 'main', randomIndex }),
      /Unsafe repository workspace folder/
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log('Branch-color workspace names, collision resistance and path safety passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
