'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const ACCOUNT_KEY = 'sweetiebot.ai-review-account';
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

function cleanGhEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_DEBUG', 'DEBUG']) delete env[key];
  env.GH_PROMPT_DISABLED = '1';
  return env;
}

async function reviewerIdentity(expected, run = runFile, source = process.env) {
  const env = cleanGhEnvironment(source);
  const options = { env, timeout: 15000, maxBuffer: 1024 * 1024 };
  let account;
  try {
    account = (await run('git', ['config', '--global', '--get', ACCOUNT_KEY], options)).stdout.trim();
  } catch {
    throw new Error('Configure a dedicated GitHub AI reviewer with git config --global ' + ACCOUNT_KEY + ' USERNAME.');
  }
  if (!LOGIN.test(account)) throw new Error('The configured GitHub AI reviewer username is invalid.');
  if (expected && account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('The configured AI reviewer changed. Cancel and re-select the review.');
  }
  let token;
  try {
    token = (await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account], options)).stdout.trim();
  } catch {
    throw new Error('The configured AI reviewer is not authenticated in GitHub CLI. Run gh auth login for that account.');
  }
  if (!token || /\s/.test(token)) throw new Error('GitHub CLI returned no usable AI reviewer credential.');
  const authenticatedEnv = { ...env, GH_TOKEN: token, GH_HOST: 'github.com' };
  let login;
  try {
    login = (await run('gh', ['api', 'user', '--hostname', 'github.com', '--jq', '.login'],
      { ...options, env: authenticatedEnv })).stdout.trim();
  } catch {
    throw new Error('Could not verify the configured GitHub AI reviewer identity.');
  }
  if (login.toLowerCase() !== account.toLowerCase()) {
    throw new Error('GitHub authenticated a different account than the configured AI reviewer.');
  }
  return { login, accessToken: token, env: authenticatedEnv };
}

// Restrict the explicit Codex command to additive, non-approving PR comments.
function reviewArguments(args) {
  const [operation, target, ...rest] = args;
  if (!['review', 'comment'].includes(operation) || !/^[1-9]\d*$/.test(target || '')) {
    throw new Error('Usage: codex-review-gh.js review|comment PR_NUMBER --repo OWNER/REPO --body TEXT (or --body-file FILE)');
  }
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!['--repo', '--body', '--body-file'].includes(flag) || !value ||
        value.startsWith('--') || values.has(flag)) throw new Error('Invalid AI review arguments.');
    values.set(flag, value);
  }
  if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(values.get('--repo') || '') ||
      values.has('--body') === values.has('--body-file')) throw new Error('Specify a repository and exactly one review body.');
  const result = ['pr', operation, target, '--repo', values.get('--repo')];
  if (operation === 'review') result.push('--comment');
  const bodyFlag = values.has('--body') ? '--body' : '--body-file';
  result.push(bodyFlag, values.get(bodyFlag));
  return result;
}

module.exports = { cleanGhEnvironment, reviewerIdentity, reviewArguments };
