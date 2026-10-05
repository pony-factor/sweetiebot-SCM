'use strict';

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9_$.-]{2,}/g) || [];
}

function boundedDamerauLevenshtein(a, b, maxDistance) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let twoRowsBack = Array.from({ length: b.length + 1 }, (_, index) => index);
  let previous = [...twoRowsBack];
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1);
    current[0] = i;
    let rowMinimum = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      let distance = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      if (
        i > 1 && j > 1
        && a[i - 1] === b[j - 2]
        && a[i - 2] === b[j - 1]
      ) {
        distance = Math.min(distance, twoRowsBack[j - 2] + 1);
      }
      current[j] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    twoRowsBack = previous;
    previous = current;
  }
  return previous[b.length];
}

function fuzzyTokenScore(token, hayTokens) {
  if (!/^[a-z]{4,}$/.test(token)) return 0;
  const maxDistance = token.length >= 8 ? 2 : 1;
  let best = 0;
  for (const candidate of hayTokens) {
    if (
      !/^[a-z]{4,}$/.test(candidate)
      || Math.abs(token.length - candidate.length) > maxDistance
    ) continue;
    const edgeMatches = token[0] === candidate[0]
      || token[token.length - 1] === candidate[candidate.length - 1]
      || (
        maxDistance > 1
        && token[1] === candidate[1]
        && token[token.length - 2] === candidate[candidate.length - 2]
      );
    if (!edgeMatches) continue;
    const distance = boundedDamerauLevenshtein(token, candidate, maxDistance);
    if (distance > maxDistance) continue;
    best = Math.max(best, 1 - distance / Math.max(token.length, candidate.length));
    if (best >= 0.95) break;
  }
  return best;
}

function keywordScore(query, text, { fuzzy = false } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const haystack = String(text || '').toLowerCase();
  if (!q || !haystack) return 0;
  const tokens = [...new Set(tokenize(q))];
  if (!tokens.length) return haystack.includes(q) ? 1 : 0;
  const hayTokens = fuzzy ? [...new Set(tokenize(haystack))] : [];
  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      matched += 1;
    } else if (fuzzy) {
      matched += fuzzyTokenScore(token, hayTokens) * 0.9;
    }
  }
  const coverage = matched / tokens.length;
  return Math.min(1, coverage * 0.75 + (haystack.includes(q) ? 0.35 : 0));
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || !vector.length) return null;
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (!magnitude) return null;
  return vector.map(value => value / magnitude);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function lineAtOffset(text, offset) {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function chunkText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n');
  if (!clean.trim()) return [];
  const target = 1400;
  const overlap = 180;
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + target);
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf(' ', end));
      if (boundary > start + 700) end = boundary;
    }
    const raw = clean.slice(start, end).trim();
    if (raw) chunks.push({ text: raw, line: lineAtOffset(clean, start) });
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

module.exports = { tokenize, keywordScore, normalizeVector, cosine, chunkText };
