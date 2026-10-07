'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const util = require('node:util');
const vm = require('node:vm');

function loadExtractor(responses, platform = 'darwin') {
  const calls = [];
  let rawReads = 0;
  function execFile() {}
  execFile[util.promisify.custom] = async (command, args, options) => {
    calls.push({ command, args, options });
    const key = command === 'pdftotext'
      ? 'pdftotext'
      : command.endsWith('/osascript')
        ? 'osascript'
        : command.endsWith('/mdls')
          ? 'mdls'
          : command;
    const response = responses[key];
    if (response instanceof Error) throw response;
    return { stdout: response || '', stderr: '' };
  };

  const vscode = {
    workspace: {
      fs: {
        readFile: async () => {
          rawReads += 1;
          return Buffer.from('%PDF-1.7\n1 0 obj\nstream\ncompressed-ish bytes');
        }
      }
    }
  };
  const sandbox = {
    module: { exports: {} },
    Buffer,
    process: { platform },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'child_process') return { execFile };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../efs/extract.js'), 'utf8'), sandbox);
  return { extractor: sandbox.module.exports, calls, rawReads: () => rawReads };
}

async function run() {
  const uri = {
    scheme: 'file',
    path: '/tmp/research.pdf',
    fsPath: '/tmp/research.pdf'
  };

  let fixture = loadExtractor({
    pdftotext: 'First page\fSecond page\r\nsearchable text\u0001'
  });
  let text = await fixture.extractor.extractText(uri, 1024, 10);
  assert.equal(text, 'First page\n\nSecond page\nsearchable text');
  assert.equal(fixture.rawReads(), 0, 'PDFs must never be decoded as raw UTF-8');
  assert.equal(fixture.calls.length, 1, 'pdftotext should remain the fast first choice');
  assert.deepEqual(
    Array.from(fixture.calls[0].args.slice(0, 5)),
    ['-enc', 'UTF-8', '-eol', 'unix', '-nopgbrk']
  );

  fixture = loadExtractor({
    pdftotext: new Error('not installed'),
    osascript: 'Native PDFKit text',
    mdls: 'Spotlight fallback'
  });
  text = await fixture.extractor.extractText(uri, 1024, 10);
  assert.equal(text, 'Native PDFKit text');
  assert.equal(fixture.rawReads(), 0);
  assert.equal(fixture.calls[1].command, '/usr/bin/osascript');
  assert.match(fixture.calls[1].args.join(' '), /PDFKit/);
  assert.ok(!fixture.calls.some(call => call.command.endsWith('/mdls')),
    'Spotlight should only run after native PDFKit extraction fails');

  fixture = loadExtractor({
    pdftotext: '',
    osascript: '',
    mdls: ''
  });
  text = await fixture.extractor.extractText(uri, 1024, 10);
  assert.equal(text, '');
  assert.equal(fixture.rawReads(), 0, 'failed PDF extraction must not index binary PDF syntax');

  console.log('Workspace PDF extraction checks passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
