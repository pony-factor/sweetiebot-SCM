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
const METADATA_EXTENSIONS = new Set(['.key', '.numbers', '.pages', '.pdf']);

async function commandText(command, args, timeout = 15000) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
    const value = String(stdout || '').trim();
    return value && value !== '(null)' ? value : '';
  } catch { return ''; }
}

async function extractDocument(uri) {
  if (uri.scheme !== 'file') return '';
  const ext = path.extname(uri.fsPath).toLowerCase();
  if (ext === '.pdf') {
    const pdftotext = await commandText('pdftotext', [uri.fsPath, '-']);
    if (pdftotext) return pdftotext;
  }
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
  if (TEXTUTIL_EXTENSIONS.has(ext) || METADATA_EXTENSIONS.has(ext)) {
    const external = await extractDocument(uri);
    if (external) return external;
  }
  const buffer = Buffer.from(await vscode.workspace.fs.readFile(uri));
  if (!TEXT_EXTENSIONS.has(ext) && looksBinary(buffer)) return '';
  return buffer.toString('utf8');
}

module.exports = { TEXT_EXTENSIONS, extractText };
