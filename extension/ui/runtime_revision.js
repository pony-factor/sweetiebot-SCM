'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Hash installed executable assets, never settings, session URLs, or credentials.
function runtimeRevision(vscode, context) {
  const hash = crypto.createHash('sha256');
  const file = filename => {
    hash.update(filename);
    try { hash.update(fs.readFileSync(filename)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('missing'); }
  };
  const tree = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) tree(filename);
      else if (/\.(js|css|py)$/.test(entry.name) || entry.name === 'package.json') file(filename);
    }
  };
  for (const name of ['workbench.desktop.main.js', 'workbench.desktop.main.css']) {
    file(path.join(vscode.env.appRoot, 'out/vs/workbench', name));
  }
  tree(context.extensionPath);
  const extensionsRoot = path.dirname(context.extensionPath);
  for (const name of fs.readdirSync(extensionsRoot).sort()) {
    if (name.startsWith('jfwooten4.scm-toolkit-workspace-search-')) {
      file(path.join(extensionsRoot, name, 'package.json'));
    }
  }
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  if (codex) {
    file(path.join(codex.extensionPath, 'package.json'));
    for (const name of ['dist', 'out', 'webview']) tree(path.join(codex.extensionPath, name));
  }
  const github = vscode.extensions.getExtension('github.vscode-pull-request-github');
  if (github) {
    for (const name of ['dist', 'webviews']) tree(path.join(github.extensionPath, name));
  }
  return hash.digest('hex');
}

module.exports = { runtimeRevision };
