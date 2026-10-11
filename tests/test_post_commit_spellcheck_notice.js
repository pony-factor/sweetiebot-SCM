'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice
} = require('../efs/post_commit_spellcheck_notice');
const { renderSpellcheckDiff, parseUnifiedDiff } = require('../efs/spellcheck_diff');

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
  assert.match(html, /All proposed edits are unstaged in Source Control/);
});

test('spellcheck review opens a read-only transient panel and keeps SCM edits and drafts', async () => {
  const f = fixture({ draft: 'Do not modify this draft' });
  let panel, changeState;
  const args = [];
  const vscode = {
    ViewColumn: { Beside: 2 },
    window: {
      createWebviewPanel(...options) {
        args.push(options);
        panel = {
          active: true,
          webview: { html: '' },
          disposed: false,
          onDidChangeViewState(handler) { changeState = handler; },
          dispose() { this.disposed = true; }
        };
        return panel;
      },
      showInformationMessage() { throw new Error('No Keep/Discard notification is allowed'); }
    },
    commands: { executeCommand() { throw new Error('No SCM command should be triggered'); } }
  };
  const invocations = [];
  const diff = async (root, argv) => {
    invocations.push({ root, argv });
    return patch;
  };
  await showNotice(vscode, f.repo, { paths: ['notes/report.md', 'notes/second.mdx'], root: '/repo' }, diff);
  assert.equal(f.repo.inputBox.value, 'Do not modify this draft');
  assert.equal(args[0][0], 'sweetiebot.spellcheckDiff');
  assert.equal(args[0][2], 2);
  assert.equal(args[0][3].enableScripts, false);
  assert.match(panel.webview.html.replace(/<\/?span[^>]*>/g, ''), /Another error/);
  assert.deepEqual(invocations[0], {
    root: '/repo',
    argv: ['diff', '--no-ext-diff', '--no-color', '--unified=3', '--', 'notes/report.md', 'notes/second.mdx']
  });
  changeState({ webviewPanel: { active: false, dispose: () => panel.dispose() } });
  assert.equal(panel.disposed, true);
});

test('reverted spellcheck edits do not open an empty review window', async () => {
  const f = fixture();
  await showNotice({
    window: { createWebviewPanel() { throw new Error('unexpected panel'); } }
  }, f.repo, { paths: ['notes/report.md'], root: '/repo' }, async () => '');
  assert.equal(f.repo.inputBox.value, '');
});

test('descriptive titles carry into the preview and empty draft with the actual model', async () => {
  const title = 'Spellcheck Instinet trading and citations';
  const data = {version: 1, head, paths: ['notes/report.md'], model: 'qwen:3b', title};
  assert.equal(parseNotice(JSON.stringify(data)).title, title);
  assert.equal(parseNotice(JSON.stringify({...data, title: 'Spellcheck too short'})), null);
  assert.equal(parseNotice(JSON.stringify({...data, title: title + '\nInjected'})), null);
  const f = fixture();
  let panelTitle, html;
  const vscode = {ViewColumn: {Beside: 2}, window: {
    createWebviewPanel(_type, name) {
      panelTitle = name;
      return {webview: {set html(value) { html = value; }}, onDidChangeViewState() {}};
    }
  }};
  await showNotice(vscode, f.repo, {...data, root: '/repo'}, async () => patch, f.git);
  assert.equal(panelTitle, title);
  assert.match(html, /<h1>Spellcheck Instinet trading and citations<\/h1>/);
  assert.equal(f.repo.inputBox.value, '🤖 ' + title + '\n\nCo-authored-by: Ollama (qwen:3b) <123456+ollama-bot@users.noreply.github.com>');
  f.repo.inputBox.value = '';
  await showNotice(vscode, f.repo, {...data, root: '/repo'}, async () => patch, async () => {
    f.repo.inputBox.value = 'Draft entered while reading config';
    return '';
  });
  assert.equal(f.repo.inputBox.value, 'Draft entered while reading config');
});
