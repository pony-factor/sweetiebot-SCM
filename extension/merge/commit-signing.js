'use strict';

// Preserve the original Git author while signing as the configured local Git
// committer. GitHub verifies a GPG signature against the COMMITTER email, not
// the original author's email.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

function validIdentity(identity) {
  return identity && typeof identity.name === 'string' && !!identity.name.trim() &&
    !/[<>\r\n\x00]/.test(identity.name) &&
    typeof identity.email === 'string' &&
    /^[^\s<>\r\n\x00]+@[^\s<>\r\n\x00]+$/.test(identity.email);
}

async function signingEnabled(git) {
  return (await git('config', '--type=bool', '--default', 'false',
    '--get', 'commit.gpgsign')) === 'true';
}

async function commitIdentity(git, originalAuthor, requireSignedCommit = false) {
  if (!validIdentity(originalAuthor)) throw Error('Invalid original Git author identity.');
  const signed = requireSignedCommit || await signingEnabled(git);
  // Preserve existing unsigned-commit behavior. Only a signed commit needs the
  // local signing identity instead of the PR author's email as its committer.
  if (!signed) return { author: originalAuthor, committer: originalAuthor, signed: false };
  let name, email;
  try {
    [name, email] = await Promise.all([
      git('config', '--get', 'user.name'),
      git('config', '--get', 'user.email')
    ]);
  } catch {
    throw Error('Lindsey needs a configured local Git user.name and user.email to sign commits.');
  }
  const committer = { name: String(name).trim(), email: String(email).trim() };
  if (!validIdentity(committer)) {
    throw Error('Lindsey needs a valid local Git committer name and email to sign commits.');
  }
  return { author: originalAuthor, committer, signed: true };
}

// commit-tree has no --author option. Its author must be supplied through Git's
// environment, not by setting user.email to the original author's address.
// This helper is shared by one-PR merges, bulk merges, and sync resolutions.
async function attributedCommitTree({ directory, tree, parents, messageFile, identity }) {
  if (!identity || !validIdentity(identity.author) || !validIdentity(identity.committer) ||
      !Array.isArray(parents) || !parents.length) throw Error('Invalid signed commit identity or parents.');
  const args = ['-C', directory, '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'user.name=' + identity.committer.name,
    '-c', 'user.email=' + identity.committer.email, 'commit-tree',
    ...(identity.signed ? ['-S'] : []), tree,
    ...parents.flatMap(parent => ['-p', parent]), '-F', messageFile];
  const env = { ...process.env,
    GIT_AUTHOR_NAME: identity.author.name, GIT_AUTHOR_EMAIL: identity.author.email,
    GIT_COMMITTER_NAME: identity.committer.name, GIT_COMMITTER_EMAIL: identity.committer.email };
  return (await exec('git', args, { env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

async function verifyLocalCommitIdentity(git, sha, identity) {
  const fields = (await git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', sha)).split('\x00');
  if (fields[0] !== identity.author.name || fields[1] !== identity.author.email ||
      fields[2] !== identity.committer.name || fields[3] !== identity.committer.email) {
    throw Error('Lindsey commit author or signing committer differs from the selected identities.');
  }
  if (identity.signed) {
    if (!/(?:^|\n)gpgsig /.test(await git('cat-file', '-p', sha))) {
      throw Error('The local signed commit has no signature.');
    }
    // SSH signatures can be verified by GitHub without a local allowed-signers
    // trust file. Do not block a legitimate SSH-signed merge solely because
    // local Git cannot perform that optional trust lookup.
    const format = String(await git('config', '--get', 'gpg.format').catch(() => 'openpgp')).trim().toLowerCase();
    const allowed = format === 'ssh'
      ? String(await git('config', '--get', 'gpg.ssh.allowedSignersFile').catch(() => '')).trim()
      : '';
    if (format !== 'ssh' || allowed) await git('verify-commit', sha);
  }
}

module.exports = { signingEnabled, commitIdentity, attributedCommitTree, verifyLocalCommitIdentity };
