'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {caseRenameDetectionEnabled, findCaseOnlyRenames, stageCaseOnlyRename,
  registerCaseOnlyRenames} = require('../../extension/commits/case-only-renames');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {encoding:'utf8'});
}

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-case-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'Readme.md'), 'unchanged contents\n');
    await fs.writeFile(path.join(root, 'src', 'other.md'), 'other\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Fixture');
    git(root, 'config', 'core.ignorecase', 'true');
    await fn(root);
  } finally {
    await fs.rm(root, {recursive:true, force:true});
  }
}

test('detects case-only filenames even with core.ignorecase enabled', async () => {
  await fixture(async root => {
    assert.deepEqual(await findCaseOnlyRenames(root), []);
    await fs.rename(path.join(root, 'src', 'Readme.md'), path.join(root, 'src', 'README.md'));
    await fs.writeFile(path.join(root, 'src', 'other.md'), 'content updated\n');
    assert.deepEqual(await findCaseOnlyRenames(root), [
      {from:'src/Readme.md', to:'src/README.md'}
    ]);
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), '',
      'recognition never modifies the index');
  });
});

test('explicit staging records a real Git rename without losing other staged edits', async () => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, 'src', 'other.md'), 'new staged content\n');
    git(root, 'add', 'src/other.md');
    await fs.rename(path.join(root, 'src', 'Readme.md'), path.join(root, 'src', 'README.md'));
    await stageCaseOnlyRename(root, 'src/Readme.md', 'src/README.md');
    const changes = git(root, 'diff', '--cached', '--name-status', '-M');
    assert.match(changes, /R100\s+src\/Readme\.md\s+src\/README\.md/);
    assert.match(changes, /M\s+src\/other\.md/);
    assert.deepEqual(await findCaseOnlyRenames(root), []);
    assert.equal(await fs.readFile(path.join(root, 'src', 'README.md'), 'utf8'),
      'unchanged contents\n');
  });
});

test('never overrides staged changes to the filename being renamed', async () => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, 'src', 'Readme.md'), 'important staged edit\n');
    git(root, 'add', 'src/Readme.md');
    await fs.rename(path.join(root, 'src', 'Readme.md'), path.join(root, 'src', 'README.md'));
    await assert.rejects(stageCaseOnlyRename(root, 'src/Readme.md', 'src/README.md'),
      /already has staged changes/);
    assert.match(git(root, 'ls-files'), /src\/Readme\.md/);
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), 'src/Readme.md');
  });
});

test('ignores ordinary renames and rejects stale casing requests', async () => {
  await fixture(async root => {
    await fs.rename(path.join(root, 'src', 'Readme.md'), path.join(root, 'src', 'different.md'));
    assert.deepEqual(await findCaseOnlyRenames(root), []);
    await assert.rejects(stageCaseOnlyRename(root, 'src/Readme.md', 'src/README.md'),
      /no longer present/);
    assert.match(git(root, 'ls-files'), /src\/Readme\.md/);
  });
});

test('skips case-ambiguous index entries rather than choosing a destination', async t => {
  await fixture(async root => {
    const lower = path.join(root, 'src', 'readme.md');
    await fs.writeFile(lower, 'different file\n');
    const entries = await fs.readdir(path.join(root, 'src'));
    if (!entries.includes('Readme.md') || !entries.includes('readme.md')) {
      t.skip('Filesystem is case-insensitive');
      return;
    }
    git(root, '-c', 'core.ignorecase=false', 'add', 'src/readme.md');
    await fs.rename(path.join(root, 'src', 'Readme.md'), path.join(root, 'src', 'README.md'));
    assert.deepEqual(await findCaseOnlyRenames(root), []);
  });
});

test('case-only rename opt-out removes SCM entries, suppresses staging, and rescans when enabled', async () => {
  await fixture(async root => {
    await fs.rename(path.join(root, 'src', 'Readme.md'), path.join(root, 'src', 'README.md'));
    const repoUri = {scheme:'file', fsPath:root};
    let enabled = true;
    let settingChanges;
    let stageRename;
    let nextScan;
    let prompts = 0;
    const providers = [];
    const fakeDisposable = () => ({dispose() {}});
    const repo = {rootUri:repoUri, async status() {}};
    const vscode = {
      extensions:{getExtension:id => id === 'vscode.git' ? {
        activate:async()=>({getAPI:()=>({repositories:[repo]})})
      } : undefined},
      scm:{createSourceControl(id, name, uri) {
        assert.match(id, /^sweetiebot\.caseRenames\./);
        assert.equal(name, 'Case-only renames');
        assert.equal(uri, repoUri);
        const provider = {disposed:false, count:0,
          dispose() {this.disposed = true;},
          createResourceGroup(_id, label) {
            assert.equal(label, 'Filename capitalization changes');
            return {resourceStates:[]};
          }
        };
        providers.push(provider);
        return provider;
      }},
      Uri:{file:fsPath=>({scheme:'file', fsPath})},
      workspace:{
        getConfiguration(section, resource) {
          assert.equal(section,'sweetiebot');
          assert.equal(resource,repoUri);
          return {get(key, defaultValue) {
            assert.equal(key,'caseOnlyRenameDetection');
            assert.equal(defaultValue,true);
            return enabled;
          }};
        },
        onDidChangeConfiguration(listener) {settingChanges=listener;return fakeDisposable();},
        createFileSystemWatcher() {
          return {onDidCreate:()=>fakeDisposable(),onDidDelete:()=>fakeDisposable(),
            onDidChange:()=>fakeDisposable(),dispose() {}};
        }
      },
      commands:{registerCommand(id, listener) {
        assert.equal(id,'sweetiebot.stageCaseOnlyRename');
        stageRename=listener;
        return fakeDisposable();
      }},
      window:{
        async showWarningMessage() {prompts++;return 'Stage rename';},
        showErrorMessage(message) {throw new Error(message);}
      }
    };
    const subscriptions=[];
    const context={subscriptions};
    const tick=()=>{const scan=nextScan;nextScan=undefined;assert.ok(scan);return scan();};
    assert.equal(caseRenameDetectionEnabled(vscode,repoUri),true);
    await registerCaseOnlyRenames(vscode,context,{
      setTimer:fn=>{nextScan=fn;return {unref() {}};},
      clearTimer:()=>{nextScan=undefined;}
    });
    try {
      assert.equal(providers.length,1);
      assert.deepEqual(providers[0].caseRenameGroup.resourceStates.map(x=>x.command.arguments),
        [[root,'src/Readme.md','src/README.md']]);
      enabled=false;
      assert.equal(caseRenameDetectionEnabled(vscode,repoUri),false);
      settingChanges({affectsConfiguration:key=>key==='sweetiebot.caseOnlyRenameDetection'});
      await tick();
      assert.equal(providers[0].disposed,true);
      await stageRename(root,'src/Readme.md','src/README.md');
      assert.equal(prompts,0,'opted-out repositories never offer a stage action');
      assert.equal(git(root,'diff','--cached','--name-only').trim(),'');
      enabled=true;
      settingChanges({affectsConfiguration:key=>key==='sweetiebot.caseOnlyRenameDetection'});
      await tick();
      assert.equal(providers.length,2);
      assert.equal(providers[1].caseRenameGroup.resourceStates.length,1);
      assert.equal(providers[1].disposed,false);
    } finally {
      for (const subscription of subscriptions.reverse()) subscription.dispose();
    }
  });
});
