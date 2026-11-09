'use strict';

const fs = require('node:fs/promises');
const { executeResolution } = require('./resolution');
const { validateSelection } = require('./dashboard');

async function main() {
  const [option, file, ...extra] = process.argv.slice(2);
  if (option !== '--input' || !file || extra.length) throw Error('Usage: merge_resolution-cli.js --input handoff.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 80 * 1024 * 1024) throw Error('Invalid or oversized merge handoff.');
  const { input, selection } = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = await executeResolution(input, validateSelection(selection), {
    ...require('./lindsey-transport').createLindseyTransport(selection.repository),
    // Use the already-granted human session for native merge finalization.
    // App-authenticated reads and branch-only repairs remain separate.
    nativeAPI: process.env.GH_TOKEN ? require('../github/user-api').legacyAPI(
      require('../github/user-api').githubUserAPI(process.env.GH_TOKEN)) : undefined,
    authorHandoff: true,
    onProgress: event => process.stderr.write('LINDSEY_PROGRESS ' + JSON.stringify(event) + '\n')
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
