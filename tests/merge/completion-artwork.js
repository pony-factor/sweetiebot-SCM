'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { completionArtwork } = require('../../extension/merge/completion-artwork');

(async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-artwork-'));
  try {
    const original = path.resolve(__dirname, '../../assets/imgs/bulk-merge-cannon.jpeg');
    const bytes = fs.readFileSync(original);
    let selection = [{ fsPath: original }];
    let saved;
    const context = { globalStorageUri: { fsPath: storage }, globalState: {
      get() { return saved; }, async update(_key, value) { saved = value; }
    } };
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, window: {
      async showOpenDialog(options) {
        assert.equal(options.canSelectMany, false);
        assert.equal(options.canSelectFolders, false);
        return selection;
      }
    } };
    const artwork = completionArtwork(vscode, context, original);
    assert.deepEqual(artwork.current(), { path: original, custom: false });
    assert(await artwork.change());
    const custom = artwork.current();
    assert(custom.custom);
    assert(custom.path.startsWith(path.join(storage, 'merge-artwork') + path.sep));
    assert(fs.readFileSync(custom.path).equals(bytes), 'Copy the image into the approved storage root');
    assert(fs.readFileSync(original).equals(bytes), 'Preserve the selected original');
    assert.deepEqual(completionArtwork(vscode, context, original).current(), custom,
      'Restore the saved image in another dashboard');
    selection = undefined;
    assert.equal(await artwork.change(), false);
    assert.deepEqual(artwork.current(), custom, 'Cancel retains the previous image');
    const invalid = path.join(storage, 'invalid.png');
    fs.writeFileSync(invalid, 'This is not an image');
    selection = [{ fsPath: invalid }];
    await assert.rejects(artwork.change(), /PNG, JPEG, GIF, or WebP/);
    assert.deepEqual(artwork.current(), custom, 'Reject invalid images without losing the previous choice');
    const large = path.join(storage, 'large.png');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 21 * 1024 * 1024);
    selection = [{ fsPath: large }];
    await assert.rejects(artwork.change(), /20 MB/);
    assert(await artwork.change(true));
    assert.equal(saved, undefined);
    assert.deepEqual(artwork.current(), { path: original, custom: false });
    assert.deepEqual(completionArtwork(vscode, context, original).current(), artwork.current());
    console.log('Completion artwork selection, persistence, cancel, validation, and reset passed.');
  } finally { fs.rmSync(storage, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
