'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  lindseyScript, safeRelative, inspectPreview, applyPreview, generatePreview, offerConflictRecoveryOptions
} = require('../../extension/merge/lindsey-conflicts');
const { prepareChatGPTSyncPreview } = require('../../extension/merge/sync-chatgpt');

async function run() {
  for (const invalid of ['../../secret', '/tmp/abc', '.git/index', 'a//b', 'a\\b', '']) {
    assert.equal(safeRelative(invalid), false);
  }
  assert.equal(safeRelative('src/file.js'), true);

  const calls = [];
  let selection = 'cancel';
  const vscode = {
    window: { showQuickPick: async items => items.find(item => item.id === selection) },
    commands: { executeCommand: async command => { calls.push(command); } }
  };
  const repo = { state: { mergeChanges: [{ resourceUri: { path: '/tmp/a' } }] } };
  const propose = async () => { calls.push('proposal'); };
  for (const [choice, expected] of [
    ['cancel', []], ['review', ['workbench.view.scm']],
    ['manual', ['workbench.view.scm', 'git.openMergeEditor']],
    ['output', ['git.showOutput']], ['lindsey', ['proposal']]
  ]) {
    selection = choice;
    await offerConflictRecoveryOptions(vscode, repo, propose);
    assert.deepEqual(calls.splice(0), expected);
  }

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-lindsey-test-'));
  const root = path.join(folder, 'example'), tmp = path.join(folder, 'preview');
  fs.mkdirSync(root); fs.mkdirSync(tmp);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'topic');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    git('add', 'file.txt'); git('commit', '-m', 'Base');
    const base = git('rev-parse', 'HEAD');
    const original = Buffer.from('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n');
    fs.writeFileSync(path.join(root, 'file.txt'), original);
    const blob = git('rev-parse', base + ':file.txt');
    const index = '100644 ' + blob + ' 1\tfile.txt\n' +
      '100644 ' + blob + ' 2\tfile.txt\n' +
      '100644 ' + blob + ' 3\tfile.txt\n';
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: index });
    const candidate = 'candidate-0.txt';
    fs.writeFileSync(path.join(tmp, candidate), 'merged\n');
    const manifest = {
      version: 1, head: base, branch: 'topic',
      files: [{ path: 'file.txt', candidate,
        originalSha: createHash('sha256').update(original).digest('hex') }]
    };
    const mockRepo = { rootUri: { fsPath: root }, async status() {} };
    assert.equal((await inspectPreview(mockRepo, tmp, manifest)).length, 1);
    assert.equal(await applyPreview(mockRepo, tmp, manifest), 1);
    assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'merged\n');
    assert.match(git('ls-files', '-u', '--', 'file.txt'), /file.txt/);
    await assert.rejects(applyPreview(mockRepo, tmp, manifest), /changed while Lindsey/);
    await assert.rejects(inspectPreview(mockRepo, tmp,
      { ...manifest, files: [{ ...manifest.files[0], path: '../../bad' }] }), /invalid/);
    fs.writeFileSync(path.join(root, 'file.txt'), original);
    let approve = false;
    const syncUI = {
      Uri: { file: value => value },
      commands: { executeCommand: async command => assert.equal(command, 'vscode.diff') },
      window: { showInformationMessage: async (message, action) => {
        assert.match(message, /configured Lindsey App identity/);
        assert.equal(action, 'Apply and sync with Lindsey');
        return approve ? action : undefined;
      } }
    };
    const previewOptions = { sync: true, findScript: () => '/fixture/resolve-conflicts.js',
      run: async (_, args, options) => {
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1', 'VS Code must run the resolver as Node');
        const output = args[args.indexOf('--output') + 1];
        fs.writeFileSync(path.join(output, candidate), 'merged\n');
        return { stdout: JSON.stringify(manifest) };
      }
    };
    assert.equal(await generatePreview(syncUI, mockRepo, previewOptions), undefined);
    assert.deepEqual(fs.readFileSync(path.join(root, 'file.txt')), original, 'Cancellation preserves the conflict');
    approve = true;
    assert.deepEqual(await generatePreview(syncUI, mockRepo, previewOptions), { files: [{
      path: 'file.txt', sha256: createHash('sha256').update('merged\n').digest('hex')
    }] });
    assert(git('ls-files', '-u'), 'Preview returns reviewed bytes to the sync coordinator before staging');
    fs.writeFileSync(path.join(root, 'file.txt'), original);
    assert.deepEqual(await generatePreview(syncUI, mockRepo, {
      sync: true,
      lindsey: async (checkout, output) => {
        assert.equal(checkout, root);
        fs.writeFileSync(path.join(output, candidate), 'merged\n');
        return manifest;
      },
      run: async () => { assert.fail('App-authenticated sync should not invoke the shared-secret CLI'); }
    }), { files: [{ path: 'file.txt', sha256: createHash('sha256').update('merged\n').digest('hex') }] });

    const untouched = 'unchanged local context\n';
    const diff3 = Buffer.from('<<<<<<< HEAD\nours\n||||||| ancestor\ncommon behavior\n=======\ntheirs\n>>>>>>> main\n');
    fs.writeFileSync(path.join(root, 'file.txt'), untouched + diff3);
    const repository = 'pony-factor/example';
    const details = { branch: 'topic', head: base, target: 'a'.repeat(40), defaultBranch: 'main' };
    let cancel;
    const webUI = {
      ...syncUI, ProgressLocation: { Notification: 15 },
      workspace: { async openTextDocument(document) {
        assert.match(document.content, /Keep both changes/);
        return document;
      } },
      window: { ...syncUI.window, async showTextDocument() {}, withProgress: async (options, task) => {
        assert.equal(options.cancellable, true);
        return task({}, { onCancellationRequested(callback) {
          cancel = callback;
          return { dispose() {} };
        } });
      } },
      commands: { async executeCommand(command, value, candidatePath) {
        if (command === 'vscode.diff') {
          assert.equal(fs.readFileSync(candidatePath, 'utf8'), untouched + 'combined implementation\n');
          return;
        }
        assert.equal(command, 'workbench.action.browser.open');
        const launch = new URL(value.url);
        assert.equal(launch.origin, 'https://chatgpt.com');
        assert(!value.url.includes('file.txt'), 'Conflict text stays out of the navigation URL');
        const callback = new URLSearchParams(launch.hash.slice(1)).get('return_to');
        const { prompt } = await (await fetch(callback + '/prompt')).json();
        assert.match(prompt, /file\.txt/);
        assert(prompt.includes(untouched.trim()), 'The local context accompanies the conflict');
        assert.match(prompt, /"base":"common behavior/);
        const post = result => fetch(callback, {
          method: 'POST', headers: { Origin: new URL(callback).origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, repository, results: [result] })
        });
        const proposal = { headSha: base, baseSha: details.target, resolutionHunks: [
          { path: 'file.txt', hunks: [{ index: 0, choice: 'custom', resolved: 'combined implementation\n' }] }
        ], decisions: [{ path: 'file.txt', title: '🛠️ Keep both changes',
          description: 'Both sides add an independent line.' }] };
        assert.equal((await post({ ...proposal, baseSha: base })).status, 400);
        assert.equal((await post({ ...proposal, resolutionHunks: [] })).status, 400);
        assert.equal((await post({ ...proposal, decisions: [] })).status, 400);
        for (const hunk of [{ index: 0, choice: 'ours' }, { index: 0, choice: 'custom', resolved: 'ours\n' }]) {
          const oneSide = await post({ ...proposal, resolutionHunks: [{ path: 'file.txt', hunks: [hunk] }] });
          assert.equal(oneSide.status, 400);
          assert.match((await oneSide.json()).error, /before choosing one side/);
        }
        assert.deepEqual(await (await post(proposal)).json(), { syncPreview: true });
      } }
    };
    approve = false;
    const webPreview = () => generatePreview(webUI, mockRepo, { sync: true, lindsey: (checkout, output) =>
      prepareChatGPTSyncPreview(webUI, repository, details, checkout, output) });
    assert.equal(await webPreview(), undefined);
    assert.deepEqual(fs.readFileSync(path.join(root, 'file.txt')), Buffer.concat([Buffer.from(untouched), diff3]));
    webUI.commands.executeCommand = async command => {
      assert.equal(command, 'workbench.action.browser.open');
      cancel();
    };
    assert.equal(await webPreview(), undefined);
    assert(git('ls-files', '-u'), 'ChatGPT review does not stage the conflict');
    // The complete ChatGPT handoff, preview, and application must support
    // more than eight conflicted files without staging them.
    const names = ['file.txt', ...Array.from({ length: 8 }, (_, i) => 'file-' + i + '.txt')];
    for (const name of names.slice(1)) {
      fs.writeFileSync(path.join(root, name), untouched + diff3);
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: root, input: index.replaceAll('file.txt', name)
      });
    }
    const reviewed = [];
    webUI.commands.executeCommand = async (command, value, candidatePath) => {
      if (command === 'vscode.diff') {
        reviewed.push(path.basename(value));
        assert.equal(fs.readFileSync(candidatePath, 'utf8'), untouched + 'combined implementation\n');
        return;
      }
      assert.equal(command, 'workbench.action.browser.open');
      const callback = new URLSearchParams(new URL(value.url).hash.slice(1)).get('return_to');
      const { prompt } = await (await fetch(callback + '/prompt')).json();
      const evidence = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
      assert.deepEqual(evidence.files.map(file => file.path).sort(), [...names].sort());
      const proposal = {
        headSha: base, baseSha: details.target,
        resolutionHunks: evidence.files.map(file => ({
          path: file.path, hunks: [{ index: 0, choice: 'custom', resolved: 'combined implementation\n' }]
        })),
        decisions: evidence.files.map(file => ({
          path: file.path, title: '🛠️ Keep both changes', description: 'Both sides add an independent line.'
        }))
      };
      const post = result => fetch(callback, {
        method: 'POST', headers: { Origin: new URL(callback).origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, repository, results: [result] })
      });
      assert.equal((await post({ ...proposal, resolutionHunks: proposal.resolutionHunks.slice(1) })).status, 400);
      assert.equal((await post({ ...proposal, decisions: proposal.decisions.slice(1) })).status, 400);
      assert.deepEqual(await (await post(proposal)).json(), { syncPreview: true });
    };
    approve = true;
    const multiple = await webPreview();
    assert.deepEqual(reviewed.sort(), [...names].sort());
    assert.deepEqual(multiple.files.map(file => file.path).sort(), [...names].sort());
    assert.equal(multiple.decisions.length, names.length);
    for (const name of names) {
      assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), untouched + 'combined implementation\n');
      assert(git('ls-files', '-u', '--', name), 'Review must not stage ' + name);
    }
    const failedPreview = stderr => generatePreview(syncUI, mockRepo, {
      ...previewOptions, run: async () => { throw Object.assign(new Error('Command failed'), { stderr }); }
    });
    await assert.rejects(failedPreview('Set LINDSEY_RESOLVE_SECRET in Sweetiebot’s local environment'),
      error => /service is not configured/.test(error.message) && !error.stderr && !error.cause);
    await assert.rejects(failedPreview('private provider diagnostics'),
      error => /could not prepare conflict proposals/.test(error.message) && !error.message.includes('private provider'));
    assert.throws(() => lindseyScript(root, [], '/nonexistent/lindsey-sync', folder), /not available locally/);
    const checkout = path.join(folder, 'GitHub', 'pony-factor', 'lindsey-sync');
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
    const resolver = path.join(checkout, 'scripts', 'resolve-conflicts.js');
    fs.writeFileSync(resolver, '// fixture');
    assert.equal(lindseyScript(root, [], undefined, folder), resolver,
      'Managed worktrees can find the standard Lindsey checkout');
    const explicit = path.join(folder, 'custom-lindsey');
    fs.mkdirSync(path.join(explicit, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(explicit, 'scripts', 'resolve-conflicts.js'), '// fixture');
    assert.equal(lindseyScript(root, [], explicit, folder), path.join(explicit, 'scripts', 'resolve-conflicts.js'),
      'Explicit resolver configuration takes precedence');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
