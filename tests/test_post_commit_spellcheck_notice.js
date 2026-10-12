'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  finishSpellcheckPreview, saveSpellcheckEdit, closeSpellcheckPopup, takeSpellcheckPopup, parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice
} = require('../efs/post_commit_spellcheck_notice');
const { renderSpellcheckDiff, parseUnifiedDiff, highlightChange } = require('../efs/spellcheck_diff');

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
  assert.equal(coauthor(email), 'Co-authored-by: Ollama <' + email + '>');
  assert.equal(coauthor(''), '');
  assert.equal(coauthor('ollama@example.com'), '');
  assert.equal(coauthor(email, 'Injected\nTrailer'), '');
  assert.match(spellcheckMessage(['a.md', 'b.mdx'], email), /^🤖 Spellcheck 2 Markdown files/);
  assert.match(spellcheckMessage(['a.md'], email), /\n\nCo-authored-by: Ollama <123456\+ollama-bot@users\.noreply\.github\.com>$/);
  assert.equal(spellcheckMessage(['a.md'], undefined, 'qwen:3b'),
    '🤖 Spellcheck 1 Markdown file\n\nCo-authored-by: Ollama (qwen:3b) <326443430+codex-pony[bot]@users.noreply.github.com>');
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
  assert.match(html, /<h1>Spellchecks Performed<\/h1>/);
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
  assert.equal(popup.title, 'Spellchecks Performed');
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
  assert.equal(popup.title, title);
  assert.match(popup.html, /<h1>Spellchecks Performed<\/h1>/);
  assert.equal(f.repo.inputBox.value, '');
  assert.equal(popup.message, '🤖 ' + title + '\n\nCo-authored-by: Ollama (qwen:3b) <123456+ollama-bot@users.noreply.github.com>');
  f.repo.inputBox.value = '';
  await showNotice(vscode, f.repo, {...data, root: '/repo'}, async () => patch, async () => {
    f.repo.inputBox.value = 'Draft entered while reading config';
    return '';
  });
  assert.equal(f.repo.inputBox.value, 'Draft entered while reading config');
  takeSpellcheckPopup();
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


test('Accept commits reviewed files with the displayed message; Revert restores only their working tree', async () => {
  for (const action of ['accept', 'revert']) {
    const f = fixture({draft: 'Keep my unrelated draft'});
    let refreshed = 0;
    f.repo.status = async () => { refreshed++; };
    const readDiff = async (_root, args) => args.includes('--cached') ? '' : patch;
    await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md'], title: 'Spellcheck trading citations and notes'}, readDiff, f.git);
    const preview = takeSpellcheckPopup();
    assert.match(preview.message, /^🤖 Spellcheck trading citations and notes/);
    const message = '🖊️ Correct the revised spelling\n\nExact edited body.\n';
    const mutations = [];
    const vscode = {Uri: {file: fsPath => ({fsPath})}, workspace: {textDocuments: []}};
    assert.deepEqual(await finishSpellcheckPreview(vscode, preview.sessionId, action, message, async (root, args) => {
      mutations.push({root, args});
    }), {action});
    assert.deepEqual(mutations, [{root: '/repo', args: action === 'accept'
      ? ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim', '--message', message, '--', 'notes/report.md']
      : ['--literal-pathspecs', 'restore', '--worktree', '--', 'notes/report.md']}]);
    assert.equal(f.repo.inputBox.value, 'Keep my unrelated draft');
    assert.equal(refreshed, 1);
    await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, action, message), /no longer available/);
  }
});

test('Accept and Revert reject changed previews, dirty editors, and staged changes without mutating Git', async () => {
  for (const problem of ['external', 'head', 'dirty', 'staged', 'empty message']) {
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
    await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'accept', problem === 'empty message' ? ' ' : preview.message,
      async () => { mutated = true; }), /changed|Save the existing|staged changes|Enter a commit/);
    if (['external', 'head', 'dirty'].includes(problem)) {
      await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'revert', '', async () => { mutated = true; }));
    }
    assert.equal(mutated, false);
    assert.equal(f.repo.inputBox.value, '');
    closeSpellcheckPopup(preview.sessionId);
  }
});

test('Accept honors the Commit and push checkbox, while Revert never pushes', async () => {
  for (const enabled of [false, true]) {
    for (const action of ['accept', 'revert']) {
      const f = fixture({draft: 'Preserve my draft'});
      const pushes = [];
      const commands = [];
      f.repo.push = async () => { pushes.push('pushed'); };
      const readDiff = async (_root, args) => args.includes('--cached') ? '' : patch;
      const readGit = async (root, args) => args[0] === 'symbolic-ref'
        ? 'refs/heads/cherry-jubilee' : f.git(root, args);
      await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']}, readDiff, readGit);
      const preview = takeSpellcheckPopup();
      const vscode = {
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
        async (_root, args) => { commands.push(args); });
      assert.equal(commands.length, 1);
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
    f.repo.push = async () => { pushed = true; throw new Error('upstream rejected'); };
    const readGit = async (root, args) => args[0] === 'symbolic-ref'
      ? (committed && switchBranch ? 'refs/heads/other' : 'refs/heads/cherry-jubilee')
      : f.git(root, args);
    await showNotice({}, f.repo, {head, root: '/repo', paths: ['notes/report.md']},
      async (_root, args) => args.includes('--cached') ? '' : patch, readGit);
    const preview = takeSpellcheckPopup();
    const vscode = {
      Uri: {file: fsPath => ({fsPath})},
      workspace: {textDocuments: [], getConfiguration: () => ({get: () => 'push'})},
      window: {showErrorMessage(message) { messages.push(message); }}
    };
    const result = await finishSpellcheckPreview(vscode, preview.sessionId, 'accept', preview.message,
      async (_root, args) => { assert.equal(args[1], 'commit'); committed = true; });
    assert.equal(committed, true);
    assert.equal(pushed, !switchBranch);
    assert.equal(result.pushed, false);
    assert.match(messages[0], /committed locally, but could not be pushed/);
    assert.match(messages[0], switchBranch ? /active branch changed/ : /upstream rejected/);
    await assert.rejects(finishSpellcheckPreview(vscode, preview.sessionId, 'accept', preview.message), /no longer available/);
  }
});
