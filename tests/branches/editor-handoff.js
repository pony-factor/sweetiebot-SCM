'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveRepositoryDocuments, moveRepositoryEditors, allowCheckoutEditor } = require('../../extension/branches/editor-handoff');
const file = fsPath => ({ scheme: 'file', fsPath, path: fsPath });
const root = '/source/repo', destination = '/topic/repo';
function fixture() {
  const text = { input: { uri: file(root + '/file.md') }, isActive: true, isPreview: false };
  const diff = { input: { original: file(root + '/before.md'), modified: file(root + '/after.md') }, isPreview: true };
  const other = { input: { uri: file('/unrelated/file.md') } };
  const chat = { input: { viewType: 'codex' } };
  const group = { viewColumn: 2, tabs: [text, diff, other, chat] };
  const calls = [], closed = [];
  const selection = { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } };
  return { text, diff, other, chat, group, calls, closed, selection,
    vscode: {
      Uri: { file }, workspace: { textDocuments: [] },
      commands: { async executeCommand(...args) { calls.push(args); } },
      window: { visibleTextEditors: [{ viewColumn: 2, document: { uri: text.input.uri }, selection }],
        tabGroups: { all: [group], async close(tabs, preserveFocus) {
          assert.equal(preserveFocus, true);
          closed.push(...tabs);
          group.tabs = group.tabs.filter(tab => !tabs.includes(tab));
          return true;
        } } }
    }
  };
}
(async () => {
  const saved = [];
  const doc = (uri, dirty = true) => ({ uri, isDirty: dirty, async save() { saved.push(uri.fsPath); this.isDirty = false; return true; } });
  const documents = [doc(file(root + '/file.md')), doc(file('/source/repository/other.md')),
    doc({ scheme: 'untitled', fsPath: root + '/draft.md' }), doc(file(root + '/clean.md'), false)];
  await saveRepositoryDocuments({ workspace: { textDocuments: documents } }, root);
  assert.deepEqual(saved, [root + '/file.md'], 'Save only dirty documents owned by the source repository');
  documents[0].isDirty = true;
  documents[0].save = async () => false;
  await assert.rejects(saveRepositoryDocuments({ workspace: { textDocuments: documents } }, root), /Save the repository/);

  const state = fixture();
  await moveRepositoryEditors(state.vscode, root, destination);
  assert.deepEqual(state.closed, [state.diff, state.text]);
  assert.deepEqual(state.group.tabs, [state.other, state.chat], 'Leave unrelated editors and Codex alone');
  assert.deepEqual(state.calls, [
    ['vscode.diff', file(destination + '/before.md'), file(destination + '/after.md'), undefined,
      { viewColumn: 2, preview: true, preserveFocus: true }],
    ['vscode.open', file(destination + '/file.md'),
      { viewColumn: 2, preview: false, preserveFocus: true, selection: state.selection }]
  ]);

  const preview = fixture();
  preview.vscode.commands.executeCommand = async () => { preview.group.tabs = [preview.other, preview.chat]; };
  await moveRepositoryEditors(preview.vscode, root, destination);
  assert.deepEqual(preview.closed, [], 'Do not close stale tab handles already replaced by preview editors');

  const failure = fixture();
  failure.vscode.commands.executeCommand = async () => { throw Error('provider failed'); };
  await assert.rejects(moveRepositoryEditors(failure.vscode, root, destination), /provider failed/);
  assert.equal(failure.closed.length, 0, 'An open failure keeps source editors available');

  const dirty = fixture();
  dirty.vscode.workspace.textDocuments = [doc(dirty.text.input.uri)];
  await assert.rejects(moveRepositoryEditors(dirty.vscode, root, destination), /changed during/);
  assert.equal(dirty.calls.length, 0);

  const race = fixture();
  race.vscode.commands.executeCommand = async () => { race.vscode.workspace.textDocuments = [doc(race.text.input.uri)]; };
  await assert.rejects(moveRepositoryEditors(race.vscode, root, destination), /changed during/);
  assert.equal(race.closed.length, 0, 'Edits during handoff must not be closed');

  const refused = fixture();
  refused.vscode.window.tabGroups.close = async () => false;
  await assert.rejects(moveRepositoryEditors(refused.vscode, root, destination), /Could not close/);

  const gitDiff = fixture();
  const gitUri = { scheme: 'git', query: JSON.stringify({ path: root + '/file.md', ref: 'HEAD' }),
    with(changes) { return { scheme: 'git', ...changes }; } };
  gitDiff.diff.input.original = gitUri;
  await moveRepositoryEditors(gitDiff.vscode, root, destination);
  assert.equal(gitDiff.calls[0][1].path, destination + '/file.md');
  assert.deepEqual(JSON.parse(gitDiff.calls[0][1].query), { path: destination + '/file.md', ref: 'HEAD' });

  const custom = fixture();
  custom.text.input.viewType = 'example.customEditor';
  await moveRepositoryEditors(custom.vscode, root, destination);
  assert.equal(custom.calls.at(-1)[0], 'vscode.openWith');
  assert.equal(custom.calls.at(-1)[2], 'example.customEditor');
  const dirtyCustom = fixture();
  dirtyCustom.text.input.viewType = 'example.customEditor';
  dirtyCustom.text.isDirty = true;
  await assert.rejects(moveRepositoryEditors(dirtyCustom.vscode, root, destination), /Save the repository/);
  assert.equal(dirtyCustom.calls.length, 0, 'Keep unsaved custom editors open');

  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'editor-alias-')));
  try {
    const actual = path.join(temporary, 'checkout');
    const alias = path.join(temporary, 'alias');
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, 'dir');
    const aliased = fixture();
    const filename = path.join(alias, 'new', 'draft.md');
    aliased.text.input.uri = file(filename);
    aliased.vscode.workspace.textDocuments = [doc(file(filename))];
    await saveRepositoryDocuments(aliased.vscode, actual);
    assert.equal(aliased.vscode.workspace.textDocuments[0].isDirty, false);
    await moveRepositoryEditors(aliased.vscode, actual, destination);
    assert.deepEqual(aliased.closed, [aliased.text]);
    assert.equal(aliased.calls[0][1].fsPath, path.join(destination, 'new', 'draft.md'));

    const main = path.join(temporary, 'main'), topic = path.join(temporary, 'cool gray');
    await Promise.all([fs.mkdir(main), fs.mkdir(topic)]);
    const listing = 'worktree ' + main + '\0branch refs/heads/main\0\0worktree ' + topic + '\0branch refs/heads/cool-gray\0\0';
    let enabled = true, selected = main;
    const warnings = [];
    const vscode = {
      workspace: {
        get workspaceFolders() { return [{ uri: file(selected) }]; },
        getConfiguration: () => ({ get: (_, fallback) => enabled ?? fallback }),
      },
      extensions: { getExtension: () => undefined },
      window: { showWarningMessage: message => warnings.push(message) },
    };
    const run = async (root, args) => args[0] === 'rev-parse' ? selected : listing;
    assert.equal(await allowCheckoutEditor(vscode, [file(path.join(topic, 'file.md'))], run), false);
    assert.match(warnings.at(-1), /Blocked file\.md from the cool-gray worktree\. This window is on main/);
    selected = topic;
    assert.equal(await allowCheckoutEditor(vscode, [file(path.join(main, 'file.md'))], run), false);
    assert.match(warnings.at(-1), /Blocked file\.md from the main worktree\. This window is on cool-gray/);
    assert.equal(await allowCheckoutEditor(vscode, [file(path.join(topic, 'file.md'))], run), true);
    enabled = false;
    assert.equal(await allowCheckoutEditor(vscode, [file(path.join(main, 'file.md'))], run), true);
    assert.equal(warnings.length, 2);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log('editor handoff tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
