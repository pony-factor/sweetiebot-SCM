'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function isExperimentWorkspace(root) {
  if (!root) return false;
  try {
    // Resolve macOS /var aliases and symlinked folder entries. The marker lives
    // beside the checkout, so it survives branch switches and Git resets.
    const repository = await fs.realpath(root);
    const marker = path.join(path.dirname(repository), '.sweetiebot-experiment.json');
    return (await fs.lstat(marker)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

module.exports = { isExperimentWorkspace };
