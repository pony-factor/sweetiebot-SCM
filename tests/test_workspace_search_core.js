'use strict';

const assert = require('assert');
const { keywordScore, bestMatchingLine, chunkText, normalizeVector, cosine } = require('../efs/core');
const { normalizeBaseUrl } = require('../efs/ollama');

assert(keywordScore('DTC federal reserve', 'DTC applied for Federal Reserve membership') > 0.7);
assert.strictEqual(keywordScore('fedaral resreve', 'Federal Reserve membership'), 0);
assert(keywordScore('fedaral resreve', 'Federal Reserve membership', { fuzzy: true }) > 0.5);
assert(keywordScore('tranfer agnet', 'registered transfer agent records', { fuzzy: true }) > 0.5);
assert.strictEqual(keywordScore('cat', 'cut', { fuzzy: true }), 0);
assert.strictEqual(
  bestMatchingLine('needle phrase', 'intro\nmore context\nneedle phrase lives here\nfooter', 20),
  22
);
assert.strictEqual(
  bestMatchingLine('tranfer agnet', 'intro\nregistered transfer agent records\nfooter', 7, { fuzzy: true }),
  8
);
assert.strictEqual(bestMatchingLine('missing', 'intro\ncontext', 12), 12);
assert(chunkText('alpha '.repeat(600)).length > 1);
const unit = normalizeVector([3, 4]);
assert(Math.abs(cosine(unit, unit) - 1) < 1e-9);
assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:11434').hostname, '127.0.0.1');
assert.throws(() => normalizeBaseUrl('https://example.com'), /local Ollama/);
console.log('Workspace Search core checks passed.');
