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

/**
 * Pony profiles are optional local enrichment, not part of PR publication.
 * Missing/old Kefania installations and read/write failures are cache misses.
 */
async function runKefaniaPonyCache(repositoryPath, input) {
  const runner = path.join(path.dirname(repositoryPath), 'kefania', 'src', 'pony-cache.js');
  try { await access(runner); } catch { return { hit: false }; }
  return new Promise(resolve => {
    let finished = false, output = '';
    const complete = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn('node', [runner], {
      cwd: repositoryPath,
      env: { ...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter) },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const timer = setTimeout(() => { child.kill(); complete({ hit: false }); }, 5000);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 100000) { child.kill(); complete({ hit: false }); }
    });
    child.stdin.on('error', () => {});
    child.on('error', () => complete({ hit: false }));
    child.on('close', code => {
      if (code !== 0) return complete({ hit: false });
      try { complete(JSON.parse(output)); }
      catch { complete({ hit: false }); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

module.exports = { runKefania, runKefaniaPonyCache };
