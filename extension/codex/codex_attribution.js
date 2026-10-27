'use strict';

// Normalize only the known noreply Codex identity; never conflate unrelated
// authors just because their names happen to include "Codex".
const EMAIL = 'noreply@openai.com';
const COAUTHOR = /^Co-authored-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i;
const VERSION = /^\d+(?:\.\d+){1,2}(?: (?:Low|Med|High|XHigh))?$/;
function isCodex(name, email) {
  return typeof name === 'string' && typeof email === 'string' &&
    email.toLowerCase() === EMAIL &&
    /^Codex(?:\s+Web|\s*\([^()\r\n]{1,90}\))?$/i.test(name.trim());
}
function parts(name) {
  if (!isCodex(name, EMAIL)) return [];
  if (/^Codex\s+Web$/i.test(name.trim())) return ['Web'];
  const inner = /^Codex\s*\(([^()]*)\)$/i.exec(name.trim())?.[1];
  return inner ? inner.split(',').map(s => s.trim()).filter(s => /^Web$/i.test(s) || VERSION.test(s))
    .map(s => /^Web$/i.test(s) ? 'Web' : s) : [];
}
function mergeNames(...names) {
  const models = new Set();
  let web = false;
  for (const name of names) for (const part of parts(name)) {
    if (part === 'Web') web = true;
    else models.add(part);
  }
  const items = [...models];
  if (web) items.push('Web');
  return items.length ? 'Codex (' + items.join(', ') + ')' : 'Codex';
}
function modelQualifier(model) {
  if (!model || typeof model !== 'object') return '';
  const name = typeof model.name === 'string' ? model.name.trim() : '';
  const version = /^(?:GPT[- ]?)?(\d+(?:\.\d+){1,2})(?:[- ]Codex)?$/i.exec(name)?.[1];
  if (!version) return ''; // Never fabricate a model from a default/config value.
  const effort = typeof model.effort === 'string' ? model.effort.trim().toLowerCase() : '';
  const level = ({ low:'Low', medium:'Med', med:'Med', high:'High',
    'extra high':'XHigh', 'extra-high':'XHigh', uber:'XHigh' })[effort] || '';
  return version + (level ? ' ' + level : '');
}
function withModel(name, model) {
  const qualifier = modelQualifier(model);
  return qualifier && isCodex(name, EMAIL) ? mergeNames(name, 'Codex (' + qualifier + ')') : name;
}
function collapse(message, trailer) {
  const input = String(message ?? '').trimEnd();
  if (!input) return '';
  const incoming = COAUTHOR.exec(trailer);
  if (!incoming) throw Error('Invalid co-author trailer');
  if (!isCodex(incoming[1], incoming[2]))
    return input.split(/\r?\n/).some(line => line.trim() === trailer) ? input : input + '\n\n' + trailer;
  const names = [incoming[1]], keep = [];
  for (const line of input.split(/\r?\n/)) {
    const found = COAUTHOR.exec(line.trim());
    if (found && isCodex(found[1], found[2])) names.push(found[1]);
    else keep.push(line);
  }
  const base = keep.join('\n').trimEnd();
  return base + (base ? '\n\n' : '') + 'Co-authored-by: ' + mergeNames(...names) + ' <' + EMAIL + '>';
}
module.exports = { EMAIL, isCodex, mergeNames, modelQualifier, withModel, collapse };

