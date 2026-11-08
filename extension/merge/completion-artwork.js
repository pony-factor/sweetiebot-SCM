'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEY = 'sweetiebot.mergeCompletionArtwork';
const MAX_BYTES = 20 * 1024 * 1024;

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw Error('Choose a PNG, JPEG, GIF, or WebP image.');
}

function completionArtwork(vscode, context, defaultPath) {
  const directory = context?.globalStorageUri?.fsPath
    ? path.join(context.globalStorageUri.fsPath, 'merge-artwork') : null;
  const saved = context?.globalState?.get(KEY);
  let customPath = directory && /^background\.(png|jpg|gif|webp)$/.test(saved || '')
    && fs.existsSync(path.join(directory, saved)) ? path.join(directory, saved) : null;
  let choosing = false;
  return {
    roots: directory ? [vscode.Uri.file(directory)] : [],
    current() { return { path: customPath || defaultPath, custom: Boolean(customPath) }; },
    async change(reset = false) {
      if (choosing) return false;
      choosing = true;
      try {
        if (!directory || !context?.globalState) throw Error('Image storage is unavailable in this window.');
        if (reset) {
          await context.globalState.update(KEY, undefined);
          customPath = null;
          return true;
        }
        const selected = await vscode.window.showOpenDialog({
          title: 'Choose completion background', openLabel: 'Use image',
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
        });
        if (!selected?.length) return false;
        const info = await fs.promises.stat(selected[0].fsPath);
        if (!info.isFile() || info.size > MAX_BYTES) throw Error('Choose an image smaller than 20 MB.');
        const bytes = await fs.promises.readFile(selected[0].fsPath);
        if (bytes.length > MAX_BYTES) throw Error('Choose an image smaller than 20 MB.');
        const filename = 'background.' + imageExtension(bytes);
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(path.join(directory, filename), bytes);
        await context.globalState.update(KEY, filename);
        customPath = path.join(directory, filename);
        return true;
      } finally { choosing = false; }
    }
  };
}

module.exports = { completionArtwork, imageExtension };
