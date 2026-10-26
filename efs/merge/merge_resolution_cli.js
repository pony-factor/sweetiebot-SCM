'use strict';

const fs = require('node:fs/promises');
const { executeResolution } = require('./merge_resolution');
const { validateSelection } = require('./merge_dashboard');

async function main() {
  const [option, file, ...extra] = process.argv.slice(2);
  if (option !== '--input' || !file || extra.length) throw Error('Usage: merge_resolution_cli.js --input handoff.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 200000) throw Error('Invalid or oversized merge handoff.');
  const { input, selection } = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = await executeResolution(input, validateSelection(selection), {
    // This local entrypoint executes an already-authorized selected merge.
    // Only the helper's last-resort human-author path may rewrite; web JSON cannot grant it.
    authorHandoff: true,
    onProgress: event => process.stderr.write('LINDSEY_PROGRESS ' + JSON.stringify(event) + '\n')
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
