'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  finishSpellcheckPreview, saveSpellcheckEdit, undoSpellcheckChange, closeSpellcheckPopup, takeSpellcheckPopup, parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice
} = require('../efs/post_commit_spellcheck_notice');
const { renderSpellcheckDiff, parseUnifiedDiff, highlightChange, spellcheckChangeSpans } = require('../efs/spellcheck_diff');

const head = 'a'.repeat(40);
const notice = JSON.stringify({ version: 1, head, paths: ['notes/report.md'] });

test('reads only valid, repo-relative Markdown notice data', () => {
  assert.deepEqual(parseNotice(notice), { head, paths: ['notes/report.md'] });
  assert.deepEqual(parseNotice(JSON.stringify({version: 1, head, paths: ['a.md'], model: 'qwen:3b'})),
    {head, paths: ['a.md'], model: 'qwen:3b'});
  assert.equal(parseNotice(JSON.stringify({version: 1, head, paths: ['a.md'], model: 'bad\ntrailer'})), null);
  assert.equal(parseNotice('not json'), null);
  assert.equal(parseNotice(JSON.stringify({ version: 1, head, paths: ['../outside.md'] })), null);
  assert.equal(parseNotice(JSON.stringify({ version: 1, head, paths: ['secret.txt'] })), null);
  assert.equal(parseNotice(JSON.stringify({ version: 1, head: 'invalid', paths: ['a.md'] })), null);
});

test('uses only a configured GitHub noreply bot identity for co-authorship', () => {
  const email = '123456+ollama-bot@users.noreply.github.com';
  assert.equal(coauthor(email), 'Co-authored-by: Spellchecker <' + email + '>');
  assert.equal(coauthor(''), '');
  assert.equal(coauthor('ollama@example.com'), '');
  assert.equal(coauthor(email, 'Injected\nTrailer'), '');
  assert.match(spellcheckMessage(['a.md', 'b.mdx'], email), /^🤖 Spellcheck Changes/);
  assert.match(spellcheckMessage(['a.md'], email), /\n\nCo-authored-by: Spellchecker <123456\+ollama-bot@users\.noreply\.github\.com>$/);
  assert.equal(spellcheckMessage(['a.md'], undefined, 'qwen:3b'),
    '🤖 Spellcheck Changes\n\nCo-authored-by: Spellchecker (Ollama qwen:3b) <326443430+codex-pony[bot]@users.noreply.github.com>');
});

function fixture({ currentHead = head, changed = true, draft = '' } = {}) {
  const files = new Map([['/repo/.git/sweetiebot-spellcheck-ready.json', notice]]);
  const movements = [];
  const io = {
    async rename(source, destination) {
      if (!files.has(source)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
      files.set(destination, files.get(source));
      files.delete(source);
      movements.push(destination);
    },
    async lstat(file) { return { isFile: () => true, size: files.get(file).length }; },
    async readFile(file) { return files.get(file); },
    async unlink(file) { files.delete(file); }
  };
  const repo = {
    rootUri: { fsPath: '/repo' },
    inputBox: { value: draft },
    state: { workingTreeChanges: changed ? [{uri: {fsPath: '/repo/notes/report.md'}}] : [], indexChanges: [] },
    async status() {},
  };
  const git = async (_cwd, args) => {
    if (args.includes('--absolute-git-dir')) return '/repo/.git';
    if (args.includes('HEAD')) return currentHead;
    if (args.some(arg => arg.endsWith('spellcheck-coauthor-email'))) return '123456+ollama-bot@users.noreply.github.com';
    throw new Error('no git value');
  };
  return { repo, io, git, files, movements };
}

test('claims one-time notice only when matching commit and unstaged edits exist', async () => {
  const fixtureA = fixture();
  const claimed = await takeNotice(fixtureA.repo, { fs: fixtureA.io, git: fixtureA.git });
  assert.deepEqual(claimed, { head, paths: ['notes/report.md'], root: '/repo' });
  assert.equal(fixtureA.files.size, 0);
  assert.equal(await takeNotice(fixtureA.repo, { fs: fixtureA.io, git: fixtureA.git }), null);
  const stale = fixture({ currentHead: 'b'.repeat(40) });
  assert.equal(await takeNotice(stale.repo, { fs: stale.io, git: stale.git }), null);
  const reverted = fixture({ changed: false });
  assert.equal(await takeNotice(reverted.repo, { fs: reverted.io, git: reverted.git }), null);
});

test('refuses to read a symlinked or oversized metadata notice', async () => {
  for (const metadata of [
    {isFile: () => false, size: 100},
    {isFile: () => true, size: 20000},
  ]) {
    const f = fixture();
    f.io.lstat = async () => metadata;
    f.io.readFile = () => { throw new Error('Should not read unsafe notice content'); };
    assert.equal(await takeNotice(f.repo, { fs: f.io, git: f.git }), null);
    assert.equal(f.files.size, 0);
  }
});

const patch = [
  'diff --git a/notes/report.md b/notes/report.md',
  'index 123..456 100644',
  '--- a/notes/report.md',
  '+++ b/notes/report.md',
  '@@ -1,3 +1,3 @@',
  ' unchanged context',
  '-This is teh <script>alert(1)</script> line.',
  '+This is the <script>alert(1)</script> line.',
  ' after context',
  'diff --git a/notes/second.mdx b/notes/second.mdx',
  '--- a/notes/second.mdx',
  '+++ b/notes/second.mdx',
  '@@ -9 +9 @@',
  '-Anotehr errror',
  '+Another error',
  ''
].join('\n');

test('renders every file and changed line as an escaped, theme-based inline diff', () => {
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(files.map(file => file.name), ['notes/report.md', 'notes/second.mdx']);
  assert.deepEqual(files[0].rows.filter(row => row.kind === 'add').map(row => row.newNumber), [2]);
  const html = renderSpellcheckDiff(patch);
  assert.match(html, /--vscode-diffEditor-insertedTextBackground/);
  assert.match(html, /--vscode-diffEditor-removedTextBackground/);
  assert.match(html, /notes\/report\.md/);
  assert.match(html, /notes\/second\.mdx/);
  assert.match(html, /changed-token/);
  const visibleText = html.replace(/<\/?span[^>]*>/g, '');
  assert.match(visibleText, /Anotehr errror/);
  assert.match(visibleText, /Another error/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /Keep edits|Discard.*button|Markdown files have/);
  assert.match(html, /<h1>Spellcheck Changes<\/h1>/);
  assert.doesNotMatch(html, /All proposed edits/);
});

test('spellcheck review queues a popup without opening an editor or modifying a draft', async () => {
  const f = fixture({ draft: 'Do not modify this draft' });
  const invocations = [];
  await showNotice({}, f.repo, { paths: ['notes/report.md', 'notes/second.mdx'], root: '/repo' }, async (root, argv) => {
    invocations.push({ root, argv });
    return patch;
  });
  assert.equal(f.repo.inputBox.value, 'Do not modify this draft');
  const popup = takeSpellcheckPopup();
  assert.equal(popup.title, 'Spellcheck Changes');
  assert.match(popup.html.replace(/<\/?span[^>]*>/g, ''), /Another error/);
  assert.equal(takeSpellcheckPopup(), undefined);
  assert.deepEqual(invocations[0], {
    root: '/repo',
    argv: ['diff', '--no-ext-diff', '--no-color', '--unified=3', '--', 'notes/report.md', 'notes/second.mdx']
  });
});

test('multiple spelling changes preserve unchanged characters between and within words', () => {
  const [before, after] = highlightChange('A speling error and an errror.', 'A spelling error and an error.');
  assert.equal(before, 'A speling error and an e<span class="changed-token">r</span>rror.');
  assert.equal(after, 'A spel<span class="changed-token">l</span>ing error and an error.');
  assert.deepEqual(highlightChange('😀 <bad>', '😀 <bed>'), [
    '😀 &lt;b<span class="changed-token">a</span>d&gt;',
    '😀 &lt;b<span class="changed-token">e</span>d&gt;'
  ]);
  const html = renderSpellcheckDiff(patch);
  assert.match(html, /minmax\(0,1fr\)/);
  assert.match(html, /white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.doesNotMatch(html, /width:max-content|minmax\(max-content/);
});


test('spellcheck change spans isolate separate typos in a shared line', () => {
  const before = 'A speling error and an errror.';
  const after = 'A spelling error and an error.';
  const spans = spellcheckChangeSpans(before, after);
  assert.deepEqual(spans.map(({before, after}) => [before, after]),
    [['speling', 'spelling'], ['errror', 'error']]);
  for (const span of spans) {
    assert.equal(after.slice(span.start, span.end), span.after);
  }
  assert.equal(spellcheckChangeSpans('unchanged', 'unchanged').length, 0);
  assert.deepEqual(spellcheckChangeSpans('same-name', 'same–name')
    .map(({before, after}) => [before, after]), [['-', '–']]);
});

test('adjacent changed words share one highlight and one Undo, with unchanged words as boundaries', () => {
  const before = 'The speling errror has anothr issue.';
  const after = 'The spelling error has another issue.';
  const spans = spellcheckChangeSpans(before, after);
  assert.deepEqual(spans.map(({before, after}) => [before, after]), [
    ['speling errror', 'spelling error'],
    ['anothr', 'another']
  ]);
  assert.equal(after.slice(spans[0].start, spans[0].end), 'spelling error');
  assert.deepEqual(spellcheckChangeSpans('bad wrds here', 'good words here')
    .map(({before, after}) => [before, after]), [['bad wrds', 'good words']]);
});

test('individual Undo restores only the selected correction and invalidates stale buttons', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'spellcheck-undo-'));
  const target = path.join(root, 'note.md');
  const baseline = 'A speling error and an errror.';
  let content = 'unchanged\nA spelling error and an error.\nending\n';
  const line = () => content.split('\n')[1];
  const readDiff = async () => line() === baseline ? '' : [
    'diff --git a/note.md b/note.md',
    '--- a/note.md',
    '+++ b/note.md',
    '@@ -1,3 +1,3 @@',
    ' unchanged',
    '-' + baseline,
    '+' + line(),
    ' ending',
    ''
  ].join('\n');
  const document = {
    uri: {fsPath: target}, isDirty: false, eol: 1,
    get lineCount() { return content.split('\n').length; },
    lineAt(number) { return {text: content.split('\n')[number], range: {line: number}}; },
    async save() { await fs.writeFile(target, content); return true; }
  };
  const vscode = {
    EndOfLine: {CRLF: 2},
    Uri: {file: fsPath => ({fsPath})},
    WorkspaceEdit: class {replace(uri, range, text) { this.change = {uri, range, text}; }},
    workspace: {
      async openTextDocument() { return document; },
      async applyEdit(edit) {
        const lines = content.split('\n');
        lines[edit.change.range.line] = edit.change.text;
        content = lines.join('\n');
        return true;
      }
    }
  };
  let preview;
  try {
    await fs.writeFile(target, content);
    await showNotice(vscode, {inputBox: {value: ''}}, {root, paths: ['note.md']}, readDiff);
    preview = takeSpellcheckPopup();
    const add = preview.files[0].rows.find(row => row.kind === 'add');
    assert.equal(add.changes.length, 2);
    assert.equal(add.originalText, baseline, 'whole-line revert retains both original typos');
    const firstId = add.changes[0].changeId;
    document.isDirty = true;
    await assert.rejects(undoSpellcheckChange(vscode, preview.sessionId, firstId), /existing editor changes/);
    document.isDirty = false;
    const afterFirst = await undoSpellcheckChange(vscode, preview.sessionId, firstId);
    assert.equal(line(), 'A speling error and an error.');
    assert.equal(afterFirst.files[0].rows.find(row => row.kind === 'add').changes.length, 1);
    assert.equal(afterFirst.files[0].rows.find(row => row.kind === 'add').originalText, baseline);
    await assert.rejects(undoSpellcheckChange(vscode, preview.sessionId, firstId), /no longer available/);
    const lastId = afterFirst.files[0].rows.find(row => row.kind === 'add').changes[0].changeId;
    const afterLast = await undoSpellcheckChange(vscode, preview.sessionId, lastId);
    assert.equal(line(), baseline);
    assert.deepEqual(afterLast.files, []);
    assert.equal(await fs.readFile(target, 'utf8'), 'unchanged\n' + baseline + '\nending\n');
  } finally {
    if (preview) closeSpellcheckPopup(preview.sessionId);
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('reverted spellcheck edits do not open an empty review window', async () => {
  const f = fixture();
  await showNotice({
    window: { createWebviewPanel() { throw new Error('unexpected panel'); } }
  }, f.repo, { paths: ['notes/report.md'], root: '/repo' }, async () => '');
  assert.equal(f.repo.inputBox.value, '');
});

test('descriptive titles appear in the proposed commit message without changing the SCM draft', async () => {
  const title = 'Spellcheck Instinet trading and citations';
  const data = {version: 1, head, paths: ['notes/report.md'], model: 'qwen:3b', title};
  assert.equal(parseNotice(JSON.stringify(data)).title, title);
  assert.equal(parseNotice(JSON.stringify({...data, title: 'Spellcheck too short'})), null);
  assert.equal(parseNotice(JSON.stringify({...data, title: title + '\nInjected'})), null);
  const f = fixture();
  const vscode = {};
  await showNotice(vscode, f.repo, {...data, root: '/repo'}, async () => patch, f.git);
  const popup = takeSpellcheckPopup();
  assert.equal(popup.title, 'Spellcheck Changes');
  assert.match(popup.html, /<h1>Spellcheck Changes<\/h1>/);
  assert.equal(f.repo.inputBox.value, '');
  assert.equal(popup.message, '');
  assert.equal(popup.trailer, undefined); // Metadata stays private to the review session.
  f.repo.inputBox.value = '';
  await showNotice(vscode, f.repo, {...data, root: '/repo'}, async () => patch, async () => {
    f.repo.inputBox.value = 'Draft entered while reading config';
    return '';
  });
  assert.equal(f.repo.inputBox.value, 'Draft entered while reading config');
  takeSpellcheckPopup();
});


test('dismissing spellcheck review carries the edited message into an empty SCM draft only', async () => {
  const f = fixture();
  await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']}, async () => patch, f.git);
  const preview = takeSpellcheckPopup();
  assert.equal(f.repo.inputBox.value, '');
  const editedMessage = '🖊️ Fix typos in citations\n\nPreserve this edited body.';
  closeSpellcheckPopup(preview.sessionId, editedMessage);
  assert.equal(f.repo.inputBox.value, editedMessage);
  closeSpellcheckPopup(preview.sessionId, 'Should not replace');
  assert.equal(f.repo.inputBox.value, editedMessage);

  const existing = fixture({draft: 'My unrelated commit message'});
  await showNotice({}, existing.repo, {head, root: '/repo', paths: ['notes/report.md']}, async () => patch, existing.git);
  const otherPreview = takeSpellcheckPopup();
  closeSpellcheckPopup(otherPreview.sessionId, otherPreview.message);
  assert.equal(existing.repo.inputBox.value, 'My unrelated commit message');

  const cancelled = fixture();
  await showNotice({}, cancelled.repo, {head, root: '/repo', paths: ['notes/report.md']}, async () => patch, cancelled.git);
  closeSpellcheckPopup(takeSpellcheckPopup().sessionId);
  assert.equal(cancelled.repo.inputBox.value, '');
});

test('in-place edits save only the intended unstaged line and reject stale or unsaved content', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'spellcheck-edit-'));
  const target = path.join(root, 'a.md');
  let content = 'unchanged\r\nspelling\r\nend\r\n';
  const diff = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,3 @@\n unchanged\n-speling\n+spelling\n end\n';
  let saves = 0;
  const document = {
    uri: {fsPath: target}, isDirty: false, eol: 2,
    get lineCount() { return content.split('\r\n').length; },
    lineAt(line) { return {text: content.split('\r\n')[line], range: {line}}; },
    async save() { saves++; await fs.writeFile(target, content); return true; }
  };
  const vscode = {EndOfLine: {CRLF: 2}, Uri: {file: fsPath => ({fsPath})},
    WorkspaceEdit: class {replace(uri, range, text) { this.change = {uri, range, text}; }},
    workspace: {
      async openTextDocument(uri) { assert.equal(uri.fsPath, target); return document; },
      async applyEdit(edit) {
        const lines = content.split('\r\n');
        lines[edit.change.range.line] = edit.change.text;
        content = lines.join('\r\n');
        return true;
      }
    }
  };
  let preview;
  try {
    await fs.writeFile(target, content);
    await showNotice(vscode, {inputBox: {value: 'Existing draft'}}, {root, paths: ['a.md']}, async () => diff);
    preview = takeSpellcheckPopup();
    const row = preview.files[0].rows.find(row => row.kind === 'add');
    assert(row.editId);
    assert.equal(preview.files[0].rows.find(row => row.kind === 'remove').editId, undefined);
    document.isDirty = true;
    await assert.rejects(saveSpellcheckEdit(vscode, preview.sessionId, row.editId, 'new'), /existing editor changes/);
    document.isDirty = false;
    content = content.replace('spelling', 'external change');
    await assert.rejects(saveSpellcheckEdit(vscode, preview.sessionId, row.editId, 'new'), /line changed/);
    content = content.replace('external change', 'spelling');
    const updated = await saveSpellcheckEdit(vscode, preview.sessionId, row.editId, 'edited\nsecond line');
    assert.equal(await fs.readFile(target, 'utf8'), 'unchanged\r\nedited\r\nsecond line\r\nend\r\n');
    assert.equal(saves, 1);
    assert.equal(updated.sessionId, preview.sessionId);
    await assert.rejects(saveSpellcheckEdit(vscode, preview.sessionId, row.editId, 'stale'), /no longer available/);
    closeSpellcheckPopup(preview.sessionId);
    await assert.rejects(saveSpellcheckEdit(vscode, preview.sessionId, updated.files[0].rows.find(row => row.kind === 'add').editId, 'closed'), /no longer available/);
  } finally {
    if (preview) closeSpellcheckPopup(preview.sessionId);
    await fs.rm(root, {recursive: true, force: true});
  }
});


test('Accept stages reviewed files before normal title generation and appends coauthor after the title', async () => {
  for (const action of ['accept', 'revert']) {
    const f = fixture({draft: 'Keep my unrelated draft'});
    let refreshed = 0;
    f.repo.status = async () => { refreshed++; };
    const readDiff = async (_root, args) => args.includes('--cached') ? '' : patch;
    await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md'], title: 'Spellcheck trading citations and notes'}, readDiff, f.git);
    const preview = takeSpellcheckPopup();
    assert.equal(preview.message, '');
    const message = '🖊️ Correct the revised spelling\n\nExact edited body.\n';
    const mutations = [];
    const vscode = {Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: []}};
    const generate = async (root, paths) => {
      mutations.push({generatedFrom: root, paths});
      return {title: '🖊️ Correct trading citations', description: 'Fix spelling without changing figures.'};
    };
    assert.deepEqual(await finishSpellcheckPreview(vscode, preview.sessionId, action, message, async (root, args) => {
      mutations.push({root, args});
    }, async () => {}, generate), {action});
    assert.deepEqual(mutations, action === 'accept'
      ? [
          {root: '/repo', args: ['--literal-pathspecs', 'add', '--', 'notes/report.md']},
          {generatedFrom: '/repo', paths: ['notes/report.md']},
          {root: '/repo', args: ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim',
            '--message', '🖊️ Correct trading citations',
            '--message', 'Fix spelling without changing figures.\n\n' + message.trim(),
            '--message', 'Co-authored-by: Spellchecker <123456+ollama-bot@users.noreply.github.com>',
            '--', 'notes/report.md']},
        ]
      : [{root: '/repo', args: ['--literal-pathspecs', 'restore', '--worktree', '--', 'notes/report.md']}]);
    assert.equal(f.repo.inputBox.value, 'Keep my unrelated draft');
    assert.equal(refreshed, 1);
    await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, action, message), /no longer available/);
  }
});

test('Accept and Revert reject changed previews, dirty editors, and staged changes without mutating Git', async () => {
  for (const problem of ['external', 'head', 'dirty', 'staged', 'invalid description']) {
    const f = fixture();
    let active = false;
    const readDiff = async (_root, args) => args.includes('--cached')
      ? (problem === 'staged' ? 'staged patch' : '')
      : (active && problem === 'external' ? 'changed patch' : patch);
    const readGit = async (root, args) => active && problem === 'head' && args.includes('HEAD') ? 'b'.repeat(40) : f.git(root, args);
    await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']}, readDiff, readGit);
    const preview = takeSpellcheckPopup();
    active = true;
    const vscode = {Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: problem === 'dirty'
      ? [{uri: {fsPath: '/repo/notes/report.md'}, isDirty: true}] : []}};
    let mutated = false;
    await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'accept', problem === 'invalid description' ? '\0' : preview.message,
      async () => { mutated = true; }), /changed|Save the existing|staged changes|description is invalid/);
    if (['external', 'head', 'dirty'].includes(problem)) {
      await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'revert', '', async () => { mutated = true; }));
    }
    assert.equal(mutated, false);
    assert.equal(f.repo.inputBox.value, '');
    closeSpellcheckPopup(preview.sessionId);
  }
});

test('failed Accept preserves concurrent staged edits, branch switches, and new commits', async () => {
  for (const change of ['index', 'branch', 'head']) {
    const f = fixture();
    let staged = '', changed = false;
    const readDiff = async (_root, args) => args.includes('--cached') ? staged : patch;
    const readGit = async (root, args) => {
      if (args[0] === 'symbolic-ref') return changed && change === 'branch' ? 'refs/heads/other' : 'refs/heads/topic';
      if (args[0] === 'rev-parse') return changed && change === 'head' ? 'b'.repeat(40) : head;
      return f.git(root, args);
    };
    await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']}, readDiff, readGit);
    const preview = takeSpellcheckPopup();
    const actions = [];
    try {
      await assert.rejects(finishSpellcheckPreview(
        {Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: []}},
        preview.sessionId, 'accept', '', async (_root, args) => {
          actions.push(args[1]);
          if (args[1] === 'add') staged = patch;
        }, async () => {}, async () => {
          changed = true;
          if (change === 'index') staged = 'Concurrent staged work';
          throw new Error('Fixture title failed');
        }), /Fixture title failed.*could not be unstaged safely/);
      assert.deepEqual(actions, ['add']);
      assert.equal(staged, change === 'index' ? 'Concurrent staged work' : patch);
    } finally { closeSpellcheckPopup(preview.sessionId); }
  }
});

test('Accept honors the Commit and push checkbox, while Revert never pushes', async () => {
  for (const enabled of [false, true]) {
    for (const action of ['accept', 'revert']) {
      const f = fixture({draft: 'Preserve my draft'});
      const pushes = [];
      const commands = [];
      f.repo.push = async () => { throw new Error('Must use the SCM push command'); };
      const readDiff = async (_root, args) => args.includes('--cached') ? '' : patch;
      const readGit = async (root, args) => args[0] === 'symbolic-ref'
        ? 'refs/heads/cherry-jubilee' : f.git(root, args);
      await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']}, readDiff, readGit);
      const preview = takeSpellcheckPopup();
      const vscode = {
        commands: {async executeCommand(command, uri) {
          assert.equal(command, 'git.push');
          assert.equal(uri.fsPath, '/repo');
          pushes.push('pushed');
        }},
        Uri: {file: fsPath => ({fsPath})},
        workspace: {
          textDocuments: [],
          getConfiguration(section, resource) {
            assert.equal(section, 'git');
            assert.equal(resource.fsPath, '/repo');
            return {get: name => {
              assert.equal(name, 'postCommitCommand');
              return enabled ? 'push' : 'none';
            }};
          }
        },
      };
      const result = await finishSpellcheckPreview(vscode, preview.sessionId, action, preview.message,
        async (_root, args) => { commands.push(args); }, async () => {},
        async () => ({title: '🖊️ Fix cited typos', description: ''}));
      assert.equal(commands.length, action === 'accept' ? 2 : 1);
      assert.equal(pushes.length, enabled && action === 'accept' ? 1 : 0);
      assert.equal(result.pushed, enabled && action === 'accept' ? true : undefined);
      assert.equal(f.repo.inputBox.value, 'Preserve my draft');
    }
  }
});

test('Failed push preserves the accepted commit and reports the failure without retrying Accept', async () => {
  for (const switchBranch of [false, true]) {
    const f = fixture();
    let committed = false;
    let pushed = false;
    const messages = [];
    f.repo.push = async () => { throw new Error('Must use the SCM push command'); };
    const readGit = async (root, args) => args[0] === 'symbolic-ref'
      ? (committed && switchBranch ? 'refs/heads/other' : 'refs/heads/cherry-jubilee')
      : f.git(root, args);
    await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']},
      async (_root, args) => args.includes('--cached') ? '' : patch, readGit);
    const preview = takeSpellcheckPopup();
    const vscode = {
      Uri: {file: fsPath => ({fsPath})},
      workspace: {textDocuments: [], getConfiguration: () => ({get: () => 'push'})},
      commands: {async executeCommand(command) {
        assert.equal(command, 'git.push');
        pushed = true;
        throw new Error('upstream rejected');
      }},
      window: {showErrorMessage(message) { messages.push(message); }}
    };
    const result = await finishSpellcheckPreview(vscode, preview.sessionId, 'accept', preview.message,
      async (_root, args) => { if (args[1] === 'commit') committed = true; },
      async () => {}, async () => ({title: '🖊️ Fix cited typos', description: ''}));
    assert.equal(committed, true);
    assert.equal(pushed, !switchBranch);
    assert.equal(result.pushed, false);
    assert.match(messages[0], /committed locally, but could not be pushed/);
    assert.match(messages[0], switchBranch ? /active branch changed/ : /upstream rejected/);
    await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'accept', preview.message), /no longer available/);
  }
});


test('Accept reruns normalization before committing; a failed check keeps the preview retryable', async () => {
  const f = fixture();
  await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']},
    async (_root, args) => args.includes('--cached') ? '' : patch, f.git);
  const preview = takeSpellcheckPopup();
  const vscode = {Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: []}};
  const calls = [];
  const commit = async (_root, args) => { calls.push(args[1]); };
  await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'accept', preview.message,
    commit, async () => { throw new Error('newline check failed'); }), /newline check failed/);
  assert.deepEqual(calls, []);
  await finishSpellcheckPreview(vscode, preview.sessionId, 'accept', preview.message, commit,
    async (root, paths) => {
      assert.equal(root, '/repo');
      assert.deepEqual(paths, ['notes/report.md']);
      calls.push('normalize');
    }, async () => {
      calls.push('generate title');
      return {title: '🖊️ Fix spelling', description: ''};
    });
  assert.deepEqual(calls, ['normalize', 'add', 'generate title', 'commit']);
});


test('normal titled spellcheck commit contains only reviewed staged files and preserves unrelated staged work', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const {execFileSync} = require('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'spellcheck-staged-title-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1'}
  }).trim();
  let preview;
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Test Committer');
    git('config', 'user.email', 'committer@example.test');
    git('config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(root, 'report.md'), 'A speling issue.\n');
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'Original content.\n');
    git('add', '--', 'report.md', 'unrelated.txt');
    git('commit', '--quiet', '-m', 'Base');
    await fs.writeFile(path.join(root, 'report.md'), 'A spelling issue.\n');
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'Unrelated staged work.\n');
    git('add', '--', 'unrelated.txt');
    const baseline = git('rev-parse', 'HEAD');
    const read = async (_root, args) => git(...args);
    await showNotice({}, {inputBox: {value: ''}, async status() {}}, {
      head: baseline, root, paths: ['report.md'], model: 'qwen:3b'
    }, read, read);
    preview = takeSpellcheckPopup();
    assert.equal(preview.title, 'Spellcheck Changes');
    let generated = 0;
    const run = async (_root, args) => git(...args);
    const title = async (_root, files) => {
      generated++;
      assert.deepEqual(files, ['report.md']);
      assert.match(git('diff', '--cached', '--', 'report.md'), /\+A spelling issue\./);
      assert.deepEqual(git('diff', '--cached', '--name-only').split('\n').sort(),
        ['report.md', 'unrelated.txt']);
      return {title: '🖊️ Correct Markdown spelling', description: 'Fix the reviewed spelling error.'};
    };
    const vscode = {Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: []}};
    for (const failure of ['title', 'commit']) {
      const failingRun = async (root, args) => {
        if (failure === 'commit' && args[1] === 'commit') throw new Error('Fixture commit failed');
        return run(root, args);
      };
      await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'accept', '', failingRun,
        async () => {
          // Exercise a normalization that changes the patch before a failure.
          await fs.writeFile(path.join(root, 'report.md'), 'A spelling issue.\n\n');
        }, async () => {
          if (failure === 'title') throw new Error('Fixture title failed');
          return title(root, ['report.md']);
        }), /Fixture (title|commit) failed/);
      assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.txt');
      assert.match(git('diff', '--', 'report.md'), /\+A spelling issue\./);
      assert.equal(git('rev-parse', 'HEAD'), baseline);
    }
    generated = 0;
    await finishSpellcheckPreview({Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: []}},
      preview.sessionId, 'accept', '', run, async () => {}, title);
    assert.equal(generated, 1);
    assert.equal(git('show', '--pretty=format:', '--name-only', 'HEAD'), 'report.md');
    assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.txt');
    assert.equal(git('diff', '--', 'report.md'), '');
    const message = git('log', '-1', '--pretty=%B');
    assert.match(message, /^🖊️ Correct Markdown spelling\n\nFix the reviewed spelling error\.\n\nCo-authored-by: Spellchecker \(Ollama qwen:3b\) <326443430\+codex-pony\[bot\]@users\.noreply\.github\.com>$/);
  } finally {
    if (preview) closeSpellcheckPopup(preview.sessionId);
    await fs.rm(root, {recursive: true, force: true});
  }
});
