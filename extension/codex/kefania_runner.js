'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { resolveKefaniaFile } = require('./kefania_paths');
const { createPonyPublishQueue } = require('../commits/pony_publish_queue');
const { separateAppsEnabled, stripAppSecrets, getRoleInstallationToken } = require('../github/app_identity');

function missingAppRepositoryAccess(error) {
  return error?.code === 'SWEETIEBOT_APP_REPOSITORY_ACCESS' ||
    /\bInstall [a-z][a-z0-9-]* on this repository\b/i.test(String(error?.message || ''));
}

// Independent pony research tabs may finish together; Git index and ref edits must be serialized.
const ponyPublishQueue = createPonyPublishQueue();

async function kefaniaChildEnvironment(repository, { botOnly = false, personalCli = false,
  env = process.env, roleToken = getRoleInstallationToken } = {}) {
  const child = stripAppSecrets(env);
  child.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter);
  if (personalCli) {
    // Let gh read the user's saved local authentication. Inherited tokens may
    // belong to a different App or a CI session; never use those as a fallback.
    delete child.GH_TOKEN;
    delete child.GITHUB_TOKEN;
    child.KEFANIA_GITHUB_AUTH = 'cli';
    delete child.KEFANIA_GITHUB_PRIVATE_KEY;
    delete child.KEFANIA_GITHUB_APP_ID;
    delete child.KEFANIA_GITHUB_INSTALLATION_ID;
  } else if (separateAppsEnabled(env)) {
    const auth = await roleToken('kefania', repository, { env });
    // In Kefania's local-pr runner the cli transport accepts a GH_TOKEN
    // installation token; its native app transport still requires codex-pony.
    delete child.KEFANIA_GITHUB_PRIVATE_KEY;
    delete child.KEFANIA_GITHUB_APP_ID;
    delete child.KEFANIA_GITHUB_INSTALLATION_ID;
    child.KEFANIA_GITHUB_AUTH = 'cli';
    child.GH_TOKEN = auth.token;
    child.GITHUB_TOKEN = auth.token;
  } else if (botOnly) {
    child.KEFANIA_GITHUB_AUTH = 'app';
  }
  return child;
}

async function runKefaniaAttempt(repositoryPath, input, { botOnly = false, personalCli = false } = {}) {
  const runner = await resolveKefaniaFile(repositoryPath, path.join('src', 'local-pr.js'));
  const env = await kefaniaChildEnvironment(input?.repository, { botOnly, personalCli });
  return new Promise((resolve, reject) => {
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
    child.stdin.end(JSON.stringify(input?.preparedDraft ? { ...input, source: undefined } : input));
  });
}

async function runKefania(repositoryPath, input, { botOnly = false, attempt = runKefaniaAttempt } = {}) {
  try {
    return await attempt(repositoryPath, input, { botOnly });
  } catch (error) {
    // Only missing repository access allows changing the PR opener identity.
    // No retry for other authentication, publication or transport failures.
    if (!missingAppRepositoryAccess(error)) throw error;
    return attempt(repositoryPath, input, { botOnly, personalCli: true });
  }
}

/**
 * Pony profiles are optional local enrichment, not part of PR publication.
 * Missing/old Kefania installations and read/write failures are cache misses.
 */
async function runKefaniaPonyCache(repositoryPath, input) {
  let runner;
  try { runner = await resolveKefaniaFile(repositoryPath, path.join('src', 'pony-cache.js')); }
  catch { return { hit: false }; }
  const directory = path.resolve(runner, '../..');
  void ponyPublishQueue.resume(directory);
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
      env: { ...stripAppSecrets(), PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter) },
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
      let result;
      try { result = JSON.parse(output); }
      catch { return complete({ hit: false }); }
      const saved = input?.action === 'put' && (result?.stored === true
        || result?.reason === 'existing-profile-preserved');
      const cached = input?.action === 'get' && result?.hit === true;
      if (!saved && !cached) return complete(result);
      const pack = String(input.pony?.packId || '').trim().toLowerCase();
      let slug = String(input.pony?.canonicalSlug || input.pony?.slug || '').trim().toLowerCase();
      if (pack === 'g4-stallions' && slug === 'hoofar') slug = 'hoo-far';
      const storedPath = result.path || `${pack}/${slug}.json`;
      if (cached) {
        // A cached biography renders immediately; retrying its unpublished file
        // must not delay the confirmation page or repeat character research.
        void ponyPublishQueue.enqueue(directory, input.pony, storedPath);
        return complete(result);
      }
      // The cache runner has exited, but a Git fetch/push can take longer than
      // its five-second timeout. Do not mark a successful save as a cache miss.
      clearTimeout(timer);
      void ponyPublishQueue.enqueue(directory, input.pony, storedPath)
        .then(publication => complete({ ...result, ...publication }),
          error => complete({ ...result, publicationError: error.message }));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

module.exports = { missingAppRepositoryAccess, kefaniaChildEnvironment, runKefania, runKefaniaPonyCache };
