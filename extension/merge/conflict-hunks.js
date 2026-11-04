'use strict';

const { safePatchPath } = require('./patch');

// The model names only contested hunks. Git generates the complete merged file
// from the verified head/base; no whole-file diff needs to cross the chat.
const CHOICES = new Set(['ours', 'theirs', 'both-ours-first', 'both-theirs-first', 'custom']);
const MAX_HUNK_BYTES = 32 * 1024 * 1024;

function validateResolutionHunks(value = []) {
  if (!Array.isArray(value) || value.length > 512) throw Error('Invalid compact resolution files.');
  const paths = new Set();
  let total = 0;
  return value.map(file => {
    if (!safePatchPath(file?.path) || paths.has(file.path) ||
        !Array.isArray(file.hunks) || !file.hunks.length || file.hunks.length > 4096) {
      throw Error('Each compact resolution needs a unique safe file path and nonempty hunks.');
    }
    paths.add(file.path);
    return { path: file.path, hunks: file.hunks.map((hunk, index) => {
      if (hunk?.index !== index || !CHOICES.has(hunk?.choice) ||
          (hunk.choice === 'custom') !== (typeof hunk.resolved === 'string') ||
          (hunk.choice !== 'custom' && hunk.resolved !== undefined) ||
          (hunk.ours !== undefined && typeof hunk.ours !== 'string') ||
          (hunk.theirs !== undefined && typeof hunk.theirs !== 'string')) {
        throw Error('Compact resolution hunks must be ordered and use an explicit choice.');
      }
      total += Buffer.byteLength(hunk.resolved || '') +
        Buffer.byteLength(hunk.ours || '') + Buffer.byteLength(hunk.theirs || '');
      if (total > MAX_HUNK_BYTES || /\x00/.test(hunk.resolved || '') ||
          /\x00/.test(hunk.ours || '') || /\x00/.test(hunk.theirs || '')) {
        throw Error('Compact resolution text is oversized or contains binary data.');
      }
      return { index, choice: hunk.choice,
        ...(hunk.resolved !== undefined ? { resolved: hunk.resolved } : {}),
        ...(hunk.ours !== undefined ? { ours: hunk.ours } : {}),
        ...(hunk.theirs !== undefined ? { theirs: hunk.theirs } : {}) };
    }) };
  });
}

// Git is explicitly invoked with merge.conflictStyle=merge for this route.
// Every conflict marker must be resolved; an incorrect count or expected side
// aborts rather than guessing, silently dropping lines, or selecting a side.
function applyResolutionHunks(text, hunks) {
  if (typeof text !== 'string' || !Array.isArray(hunks)) throw Error('Invalid conflict content.');
  const marker = /^<<<<<<<[^\n]*\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>>[^\n]*(?:\r?\n|$)/gm;
  const blocks = [...text.matchAll(marker)];
  if (blocks.length !== hunks.length || !blocks.length) {
    throw Error('Conflict hunk count changed; regenerate this resolution from the current base.');
  }
  let output = '', cursor = 0;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], hunk = hunks[index];
    if (hunk.index !== index || (hunk.ours !== undefined && hunk.ours !== block[1]) ||
        (hunk.theirs !== undefined && hunk.theirs !== block[2])) {
      throw Error('Conflict hunk does not match the verified Git merge.');
    }
    const ours = block[1], theirs = block[2];
    const resolved = ({
      ours: () => ours, theirs: () => theirs,
      'both-ours-first': () => ours + theirs,
      'both-theirs-first': () => theirs + ours,
      custom: () => hunk.resolved
    })[hunk.choice]();
    if (typeof resolved !== 'string' || /^(?:<<<<<<<|=======|>>>>>>>)/m.test(resolved)) {
      throw Error('Compact resolution cannot introduce conflict markers.');
    }
    output += text.slice(cursor, block.index) + resolved;
    cursor = block.index + block[0].length;
  }
  output += text.slice(cursor);
  if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(output)) throw Error('Unresolved conflict markers remain.');
  return output;
}

module.exports = { validateResolutionHunks, applyResolutionHunks };
