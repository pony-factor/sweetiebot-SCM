'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice
} = require('../efs/post_commit_spellcheck_notice');

const head = 'a'.repeat(40);
const notice = JSON.stringify({ version: 1, head, paths: ['notes/report.md'] });

test('reads only valid, repo-relative Markdown notice data', () => {
  assert.deepEqual(parseNotice(notice), { head, paths: ['notes/report.md'] });
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
  assert.doesNotMatch(spellcheckMessage(['a.md']), /Co-authored-by:/);
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

test('prefills empty SCM input and announces ready spellcheck edits', async () => {
  const f = fixture();
  const messages = [];
  const cmds = [];
  const vscode = {
    window: { async showInformationMessage(...args) { messages.push(args); return 'Review changes'; } },
    commands: { async executeCommand(name) { cmds.push(name); } },
  };
  await showNotice(vscode, f.repo, { paths: ['notes/report.md'], root: '/repo' }, f.git);
  assert.match(f.repo.inputBox.value, /^🤖 Spellcheck 1 Markdown file/);
  assert.match(f.repo.inputBox.value, /Co-authored-by: Ollama/);
  assert.match(messages[0][0], /spellcheck edits ready for review/);
  assert.deepEqual(cmds, ['workbench.view.scm']);
});

test('does not overwrite an existing SCM message unless requested', async () => {
  const f = fixture({ draft: 'My work in progress' });
  let announcement;
  const vscode = {
    window: { async showInformationMessage(...args) { announcement = args; return undefined; } },
    commands: { async executeCommand() {} },
  };
  await showNotice(vscode, f.repo, { paths: ['notes/report.md'], root: '/repo' }, f.git);
  assert.equal(f.repo.inputBox.value, 'My work in progress');
  assert.match(announcement[0], /Existing commit draft kept/);
  vscode.window.showInformationMessage = async () => 'Use spellcheck message';
  await showNotice(vscode, f.repo, { paths: ['notes/report.md'], root: '/repo' }, f.git);
  assert.match(f.repo.inputBox.value, /^🤖 Spellcheck/);
});
