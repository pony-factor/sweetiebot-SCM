'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  githubRepository, reviewSyncConflicts, reportBody,
  queueSyncReport, publishSyncReports
} = require('../extension/merge/sync_review');

async function run() {
  assert.equal(githubRepository('git@github.com:pony-factor/sweetiebot-SCM.git'),
    'pony-factor/sweetiebot-SCM');
  assert.equal(githubRepository('https://github.com/pony-factor/test.git'), 'pony-factor/test');
  assert.equal(githubRepository('https://example.com/attacker/repo'), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-sync-review-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Human Author');
    git('config', 'user.email', 'human@example.invalid');
    git('remote', 'add', 'origin', 'https://github.com/pony-factor/test.git');
    fs.writeFileSync(path.join(root, 'original'), 'first\n');
    git('add', '.'); git('commit', '-m', 'Initial');
    git('branch', 'topic');
    fs.writeFileSync(path.join(root, 'upstream'), 'main content\n');
    git('add', '.'); git('commit', '-m', 'Human upstream commit');
    const target = git('rev-parse', 'main');
    git('switch', 'topic');
    fs.writeFileSync(path.join(root, 'topic'), 'topic content\n');
    git('add', '.'); git('commit', '-m', 'Human topic commit');
    const before = git('rev-parse', 'HEAD');
    git('update-ref', 'rextension/remotes/origin/main', target);
    git('merge', '--no-ff', '--no-edit', 'main');
    const sha = git('rev-parse', 'HEAD');
    const record = { branch: 'topic', defaultBranch: 'main', remote: 'origin',
      before, target, sha, strategy: 'merge' };
    assert.equal(await queueSyncReport(root, record), true);
    const directory = path.join(git('rev-parse', '--absolute-git-dir'), 'sweetiebot-sync-reports');
    const journal = path.join(directory, sha + '.json');
    assert(fs.existsSync(journal), 'report is durable until remote publication');

    let posted = 0;
    let remoteSha = before;
    const comments = [];
    const api = async (endpoint, method, body) => {
      if (endpoint.includes('/git/ref/heads/')) return { object: { sha: remoteSha } };
      if (method === 'POST') { posted++; comments.push({ body }); return { id: posted }; }
      if (endpoint.endsWith('/comments?per_page=100')) return comments;
      throw Error('Unexpected endpoint ' + endpoint);
    };
    assert.equal(await publishSyncReports(root, { api }), 0);
    assert.equal(posted, 0, 'Never comment before GitHub confirms publication');
    remoteSha = sha;
    assert.equal(await publishSyncReports(root, { api }), 1);
    assert.equal(posted, 1);
    assert(!fs.existsSync(journal), 'successful delivery clears pending journal');
    assert.match(comments[0].body, /inherited from upstream/);
    assert.match(comments[0].body, /sweetiebot-sync-report:/);
    assert.equal(await publishSyncReports(root, { api }), 0);
    assert.equal(posted, 1, 'repeat polls cannot duplicate comments');
    assert.match(reportBody({ ...record, files: ['upstream'] }), /upstream/);

    // A previously published comment is also deduplicated after an interrupted
    // publisher fails to clear its local journal.
    assert.equal(await queueSyncReport(root, record), true);
    assert.equal(await publishSyncReports(root, { api }), 1);
    assert.equal(posted, 1);

    let choices = ['inspect', 'own'];
    const opened = [];
    const repository = {
      rootUri: { fsPath: root }, state: { HEAD: { name: 'topic' } },
      inputBox: { value: 'Draft' },
      async status() { this.state.HEAD.name = git('branch', '--show-current'); }
    };
    const vscode = {
      window: {
        async showQuickPick(items) {
          const choice = choices.shift();
          return items.find(item => item.id === choice);
        },
        async showInputBox({ value }) { assert.match(value, /Prepare topic/); return '🛠️ Human edit'; },
        async showTextDocument(document) { opened.push(document); }
      },
      workspace: { async openTextDocument(options) { return options; } },
      commands: { async executeCommand(command) { assert.equal(command, 'workbench.view.scm'); } }
    };
    const review = { branch: 'topic', defaultBranch: 'main', remote: 'origin',
      head: sha, target, strategy: 'merge' };
    assert.equal(await reviewSyncConflicts(vscode, repository, review), false);
    assert.equal(opened.length, 1, 'review opens a diff-text snapshot');
    assert.equal(repository.inputBox.value, '🛠️ Human edit');
    assert.equal(git('rev-parse', 'HEAD'), sha, 'review never creates a commit');
    choices = ['cancel'];
    assert.equal(await reviewSyncConflicts(vscode, repository, review), false);
    choices = ['resolve'];
    assert.equal(await reviewSyncConflicts(vscode, repository, review), true);
    await assert.rejects(reviewSyncConflicts(vscode, repository, { ...review, head: before }),
      /revisions or working files changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Human sync preflight and verified report publication passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
