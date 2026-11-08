'use strict';
const { separateAppsEnabled, getRoleInstallationToken } = require('./app-identity');

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Use GitHub's verified fork parent, not a guessed "upstream" remote.
async function resolveForkPullRequestTarget(vscode, repositoryUrl, base, request) {
  const name = String(repositoryUrl || '').replace(/^https:\/\/github\.com\//, '');
  if (!REPOSITORY_NAME.test(name)) throw new Error('Select a GitHub repository.');
  if (!request) {
    const session = await require('./session').githubSession(vscode);
    request = require('./user-api').githubUserAPI(session.accessToken);
  }
  const fork = await request('repos/' + name);
  if (fork?.full_name?.toLowerCase() !== name.toLowerCase()) {
    throw new Error('GitHub could not verify the selected repository identity.');
  }
  if (fork.fork !== true) return { repository: name, repositoryUrl, base };
  const upstream = fork.parent?.full_name;
  if (!REPOSITORY_NAME.test(upstream || '') || upstream.toLowerCase() === name.toLowerCase()) {
    throw new Error('The fork parent is unavailable; Kefania will not guess an upstream PR target.');
  }
  const parent = await request('repos/' + upstream);
  if (parent?.full_name?.toLowerCase() !== upstream.toLowerCase() ||
      !/^[A-Za-z0-9_.\/-]+$/.test(parent.default_branch || '')) {
    throw new Error('GitHub could not verify the upstream default branch.');
  }
  return { repository: upstream, repositoryUrl: 'https://github.com/' + upstream,
    headRepository: name, base: parent.default_branch, fork: true };
}

function upstreamAccessFailure(error) {
  return [401, 403, 404].includes(error?.status) ||
    error?.code === 'SWEETIEBOT_APP_REPOSITORY_ACCESS' ||
    /HTTP (?:401|403|404)|GitHub CLI is unavailable|sign in before starting Kefania|\b(?:access denied|not authorized|forbidden|repository access|cannot access|login required)\b|Install [\w-]+ on this repository/i
      .test(String(error?.message || ''));
}

async function kefaniaUpstreamAppAccess(repository) {
  if (!separateAppsEnabled()) return undefined; // Legacy App access cannot be verified here.
  try {
    await getRoleInstallationToken('kefania', repository);
    return true;
  } catch { return false; }
}

// An upstream failure is not permission to publish to a different repository.
async function chooseForkPullRequestTarget(vscode, repositoryPath, target, branch, {
  run = require('../codex/kefania-runner').runKefania,
  checkApp = kefaniaUpstreamAppAccess, priorDecision, skipProbe = false
} = {}) {
  if (!target.fork) return target;
  const fallback = { repository: target.headRepository,
    repositoryUrl: 'https://github.com/' + target.headRepository,
    base: 'main', fallbackToFork: true };
  if (priorDecision === 'fork-main') return fallback;
  if (priorDecision === 'upstream') return target;
  if (await checkApp(target.repository) !== true) {
    const choice = await vscode.window.showWarningMessage(
      `This checkout is a fork of ${target.repository}. Kefania's GitHub App access to upstream is missing or unverified. Sweetiebot will try an upstream PR from ${target.headRepository} using your authenticated GitHub account, not silently open one against your fork.`,
      { modal: true }, 'Try upstream');
    if (choice !== 'Try upstream') return undefined;
  }
  if (!skipProbe) {
    try {
      await run(repositoryPath, { repository: target.repository, headRepository: target.headRepository,
        head: branch, base: target.base, contextOnly: true }, { botOnly: true });
    } catch (error) {
      if (!upstreamAccessFailure(error)) throw error;
      const choice = await vscode.window.showWarningMessage(
        `Kefania cannot access upstream ${target.repository} (${error.message}). Open the pull request against your fork ${target.headRepository}:main instead? This will NOT create a PR on upstream.`,
        { modal: true }, 'Open PR on fork main');
      if (choice !== 'Open PR on fork main') return undefined;
      return fallback;
    }
  }
  return target;
}

module.exports = { resolveForkPullRequestTarget, chooseForkPullRequestTarget, upstreamAccessFailure };
