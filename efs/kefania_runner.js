'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { access } = require('node:fs/promises');

async function runKefania(repositoryPath, input, { botOnly = false } = {}) {
  const runner = path.join(path.dirname(repositoryPath), 'kefania', 'src', 'local-pr.js');
  await access(runner).catch(() => { throw new Error('Keep an updated kefania checkout beside this repository, with npm dependencies installed.'); });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter),
      ...(botOnly ? { KEFANIA_GITHUB_AUTH: 'app' } : {}) };
    const child = spawn('node', [runner], { cwd: repositoryPath, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Error('Node is unavailable on the VS Code PATH.')));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(error.trim() || 'Kefania was interrupted. Check GitHub for an existing PR before retrying.'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Kefania returned an invalid PR result.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
module.exports = { runKefania };
