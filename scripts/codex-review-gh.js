#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { reviewerIdentity, reviewArguments } = require('../extension/github/reviewer-account');

async function main() {
  const args = reviewArguments(process.argv.slice(2));
  const reviewer = await reviewerIdentity();
  // Never print credentials or raw subprocess errors, which include invocation metadata.
  try {
    const { stdout } = await promisify(execFile)('gh', args, {
      env: reviewer.env, timeout: 60000, maxBuffer: 1024 * 1024
    });
    process.stdout.write(stdout);
  } catch {
    throw new Error('GitHub did not confirm publication as ' + reviewer.login + '. Check the PR before retrying.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
