'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../../assets/codex/context-host.js'), 'utf8');
const context = platform => {
  const host = vm.createContext({ require, process: { platform, pid: process.pid,
    getuid: () => process.getuid?.(), kill: process.kill }, setTimeout, clearTimeout });
  vm.runInContext(source, host);
  return host;
};

async function run() {
  let clipboard = 'Original link https://example.com/keep';
  const original = clipboard;
  const vscode = { env: { clipboard: {
    readText: async () => clipboard,
    writeText: async value => { clipboard = value; }
  } } };
  const first = context('linux'), second = context('linux');
  const copy = async (host, text, fail = false) => {
    const release = await host.scmToolkitLockClipboard();
    let snapshot;
    try {
      snapshot = await host.scmToolkitSaveClipboard(vscode);
      clipboard = text;
      await new Promise(resolve => setTimeout(resolve, 15));
      if (fail) throw new Error('Native copy failed');
    } finally {
      try { await snapshot?.restore(); }
      finally { await release(); }
    }
  };
  await Promise.all([copy(first, 'Markdown export'), copy(second, 'codex://threads/example')]);
  assert.equal(clipboard, original, 'Separate extension hosts must restore the original text, never another capture marker');
  const results = await Promise.allSettled([copy(first, 'Failed export', true), copy(second, 'Public link')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(clipboard, original, 'Failure restores the clipboard and releases the cross-window lock');

  if (process.argv.includes('--native')) {
    assert.equal(process.platform, 'darwin');
    const host = context('darwin');
    const release = await host.scmToolkitLockClipboard();
    const userClipboard = await host.scmToolkitSaveClipboard(vscode);
    const swift = script => execFileSync('/usr/bin/swift', ['-e', 'import AppKit\n' + script], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      swift(`let board = NSPasteboard.general
let first = NSPasteboardItem()
first.setString("Keep this link https://example.com/original", forType: .string)
first.setString("<b>Keep formatting</b>", forType: .html)
first.setData(Data([1, 2, 3, 4]), forType: .png)
board.clearContents()
assert(board.writeObjects([first]))`);
      const snapshot = await host.scmToolkitSaveClipboard(vscode);
      try { swift('NSPasteboard.general.clearContents(); NSPasteboard.general.setString("temporary export", forType: .string)'); }
      finally { await snapshot.restore(); }
      swift(`let items = NSPasteboard.general.pasteboardItems ?? []
assert(items.count == 1)
assert(items[0].string(forType: .string) == "Keep this link https://example.com/original")
assert(items[0].string(forType: .html) == "<b>Keep formatting</b>")
assert(items[0].data(forType: .png) == Data([1, 2, 3, 4]))`);
    } finally {
      try { await userClipboard.restore(); }
      finally { await release(); }
    }
  }
  console.log('Clipboard preservation and cross-window serialization passed.');
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
