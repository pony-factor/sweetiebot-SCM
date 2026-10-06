'use strict';

const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.jsx',
  '.json', '.jsonc', '.kt', '.log', '.lua', '.m', '.md', '.mdx', '.php', '.pl', '.properties', '.py', '.r',
  '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.tex', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml', '.zsh'
]);
const TEXTUTIL_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf']);
const METADATA_EXTENSIONS = new Set(['.key', '.numbers', '.pages']);
const PDF_EXTENSION = '.pdf';
const PDFKIT_JXA = \`
ObjC.import('Foundation');
ObjC.import('PDFKit');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const document = $.PDFDocument.alloc.initWithURL(url);
  if (!document) return '';
  const pages = [];
  for (let index = 0; index < document.pageCount; index += 1) {
    const page = document.pageAtIndex(index);
    const pageText = page ? page.string : null;
    if (!pageText) continue;
    const text = ObjC.unwrap(pageText);
    if (text) pages.push(String(text));
  }
  return pages.join('\\f');
}
\`.trim();

function normalizeExtractedText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function commandText(command, args, timeout = 15000) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
    const value = normalizeExtractedText(stdout);
    return value && value !== '(null)' ? value : '';
  } catch { return ''; }
}

async function extractPdf(uri) {
  const pdftotext = await commandText('pdftotext', [
    '-enc', 'UTF-8', '-eol', 'unix', '-nopgbrk', uri.fsPath, '-'
  ]);
  if (pdftotext) return pdftotext;

  if (process.platform === 'darwin') {
    const pdfKit = await commandText(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', PDFKIT_JXA, uri.fsPath],
      30000
    );
    if (pdfKit) return pdfKit;
    return commandText('/usr/bin/mdls', ['-raw', '-name', 'kMDItemTextContent', uri.fsPath]);
  }
  return '';
}

async function extractDocument(uri) {
  if (uri.scheme !== 'file') return '';
  const ext = path.extname(uri.fsPath).toLowerCase();
  if (ext === PDF_EXTENSION) return extractPdf(uri);
  if (TEXTUTIL_EXTENSIONS.has(ext)) {
    const converted = await commandText('/usr/bin/textutil', ['-convert', 'txt', '-stdout', uri.fsPath]);
    if (converted) return converted;
  }
  if (METADATA_EXTENSIONS.has(ext)) {
    return commandText('/usr/bin/mdls', ['-raw', '-name', 'kMDItemTextContent', uri.fsPath]);
  }
  return '';
}

function looksBinary(buffer) {
  if (!buffer || !buffer.length) return false;
  const limit = Math.min(buffer.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < limit; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / limit > 0.08;
}

async function extractText(uri, size, maxFileSizeMB) {
  const maxBytes = Math.floor(maxFileSizeMB * 1024 * 1024);
  if (size > maxBytes) return '';
  const ext = path.extname(uri.path).toLowerCase();

  // PDFs are binary even when their header and object table look mostly ASCII.
  // Never fall through to raw UTF-8 decoding: failed extraction would otherwise
  // index PDF syntax/compressed streams as garbage search passages.
  if (ext === PDF_EXTENSION) return extractDocument(uri);

  if (TEXTUTIL_EXTENSIONS.has(ext) || METADATA_EXTENSIONS.has(ext)) {
    const external = await extractDocument(uri);
    if (external) return external;
  }
  const buffer = Buffer.from(await vscode.workspace.fs.readFile(uri));
  if (!TEXT_EXTENSIONS.has(ext) && looksBinary(buffer)) return '';
  return buffer.toString('utf8');
}

module.exports = { TEXT_EXTENSIONS, extractText, normalizeExtractedText };
