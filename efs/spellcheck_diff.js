'use strict';

// Render the actual working-tree patch, not an action dialog. Keep all text escaped.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function parseUnifiedDiff(patch) {
  const files = [];
  let file = null;
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const line of String(patch).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/ b\/(.+)$/);
      file = { name: match ? match[1] : 'Changed file', rows: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+++ ')) {
      if (line.startsWith('+++ b/')) file.name = line.slice(6);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      file.rows.push({ kind: 'hunk', text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\ No newline at end of file')) {
      file.rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith('-')) {
      file.rows.push({ kind: 'remove', text: line.slice(1), oldNumber: oldNumber++ });
    } else if (line.startsWith('+')) {
      file.rows.push({ kind: 'add', text: line.slice(1), newNumber: newNumber++ });
    } else if (line.startsWith(' ')) {
      file.rows.push({ kind: 'context', text: line.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
    }
  }
  return files;
}

function highlightChange(before, after, segments = false) {
  const left = Array.from(before), right = Array.from(after);
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start
      && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  const a = left.slice(start, left.length - end), b = right.slice(start, right.length - end);
  const sameA = new Set(), sameB = new Set();
  // Bound memory for unusually large replacements; ordinary prose uses exact character alignment.
  if ((a.length + 1) * (b.length + 1) <= 4000000) {
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] = a[i] === b[j] ? 1 + lcs[(i + 1) * width + j + 1]
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) { sameA.add(i++); sameB.add(j++); }
      else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++;
      else j++;
    }
  }
  function render(text, middle, same) {
    const parts = [];
    const append = (value, changed) => {
      if (!value) return;
      if (parts.at(-1)?.changed === changed) parts.at(-1).text += value;
      else parts.push({ text: value, changed });
    };
    append(text.slice(0, start).join(''), false);
    middle.forEach((character, index) => append(character, !same.has(index)));
    append(end ? text.slice(-end).join('') : '', false);
    return segments ? parts : parts.map(part => part.changed
      ? '<span class="changed-token">' + escapeHtml(part.text) + '</span>' : escapeHtml(part.text)).join('');
  }
  return [render(left, a, sameA), render(right, b, sameB)];
}

// Return independent word/punctuation corrections with offsets into the proposed line.
// Exact unchanged tokens anchor the alignment, so reverting one edit cannot
// accidentally replace the other spelling changes on that line.
function spellcheckChangeSpans(before, after) {
  if (before === after) return [];
  const tokens = text => [...text.matchAll(/\s+|[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu)]
    .map(match => ({text: match[0], start: match.index, end: match.index + match[0].length}));
  const old = tokens(before), next = tokens(after);
  const wholeLine = () => [{start: 0, end: after.length, before, after}];
  // Protect the viewer from quadratic work on unusually long Markdown lines.
  if ((old.length + 1) * (next.length + 1) > 200000) return wholeLine();
  const lcs = Array.from({length: old.length + 1}, () => new Uint32Array(next.length + 1));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lcs[i][j] = old[i].text === next[j].text ? 1 + lcs[i + 1][j + 1]
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const matches = [];
  for (let i = 0, j = 0; i < old.length && j < next.length;) {
    if (old[i].text === next[j].text) { matches.push([i++, j++]); }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  matches.push([old.length, next.length]);
  const changes = [];
  function addRange(a, b, c, e) {
    if (a === b && c === e) return;
    const start = c < e ? next[c].start : (next[c]?.start ?? after.length);
    const end = c < e ? next[e - 1].end : start;
    const beforeText = a < b ? before.slice(old[a].start, old[b - 1].end) : '';
    const afterText = after.slice(start, end);
    if (beforeText !== afterText) changes.push({start, end, before: beforeText, after: afterText});
  }
  let oldStart = 0, nextStart = 0;
  for (const [oldEnd, nextEnd] of matches) {
    // Neighboring one-token substitutions can be undone separately too.
    if (oldEnd - oldStart === nextEnd - nextStart && oldEnd - oldStart > 1) {
      for (let k = 0; k < oldEnd - oldStart; k++) {
        addRange(oldStart + k, oldStart + k + 1, nextStart + k, nextStart + k + 1);
      }
    } else addRange(oldStart, oldEnd, nextStart, nextEnd);
    oldStart = oldEnd + 1;
    nextStart = nextEnd + 1;
  }
  return changes.length ? changes : wholeLine();
}

function renderRows(rows) {
  const highlights = new Map();
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== 'remove' && rows[i].kind !== 'add') { i++; continue; }
    let j = i;
    while (j < rows.length && ['add', 'remove'].includes(rows[j].kind)) j++;
    const removed = [], added = [];
    for (let k = i; k < j; k++) (rows[k].kind === 'remove' ? removed : added).push(k);
    if (removed.length === added.length) {
      for (let k = 0; k < removed.length; k++) {
        const pair = highlightChange(rows[removed[k]].text, rows[added[k]].text);
        highlights.set(removed[k], pair[0]);
        highlights.set(added[k], pair[1]);
      }
    }
    i = j;
  }

  return rows.map((row, i) => {
    if (row.kind === 'hunk') return '<div class="hunk">' + escapeHtml(row.text) + '</div>';
    if (row.kind === 'meta') return '<div class="meta">' + escapeHtml(row.text) + '</div>';
    const sign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ';
    const oldLine = row.oldNumber == null ? '' : String(row.oldNumber);
    const newLine = row.newNumber == null ? '' : String(row.newNumber);
    return '<div class="diff-line ' + row.kind + '">'
      + '<span class="line-number">' + oldLine + '</span>'
      + '<span class="line-number">' + newLine + '</span>'
      + '<span class="sign">' + sign + '</span>'
      + '<span class="line-text">' + (highlights.get(i) ?? escapeHtml(row.text)) + '</span></div>';
  }).join('');
}

function spellcheckDiffFiles(patch) {
  return parseUnifiedDiff(patch).filter(file => file.rows.length).map(file => {
    const rows = file.rows.map(row => ({ ...row, segments: [{text: row.text, changed: false}] }));
    for (let i = 0; i < rows.length;) {
      if (!['add', 'remove'].includes(rows[i].kind)) { i++; continue; }
      let j = i;
      while (j < rows.length && ['add', 'remove'].includes(rows[j].kind)) j++;
      const removed = rows.slice(i, j).filter(row => row.kind === 'remove');
      const added = rows.slice(i, j).filter(row => row.kind === 'add');
      for (let k = 0; k < Math.min(removed.length, added.length); k++) {
        [removed[k].segments, added[k].segments] = highlightChange(removed[k].text, added[k].text, true);
        // Preserve the full original line for a one-click, line-level revert.
        added[k].originalText = removed[k].text;
        added[k].changes = spellcheckChangeSpans(removed[k].text, added[k].text);
      }
      i = j;
    }
    return { name: file.name, rows };
  });
}

function renderSpellcheckDiff(patch, title = 'Spellcheck suggestions') {
  const files = parseUnifiedDiff(patch);
  const blocks = files.filter(file => file.rows.length).map(file =>
    '<section class="file"><h2>' + escapeHtml(file.name) + '</h2><div class="rows">'
    + renderRows(file.rows) + '</div></section>'
  ).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<style>'
    + '*,*::before,*::after{box-sizing:border-box}'
    + 'body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif)}'
    + '.intro{position:sticky;top:0;z-index:2;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border,var(--vscode-editorGroup-border));padding:14px 20px}'
    + 'h1{font-size:1.15rem;margin:0 0 6px}p{margin:0;color:var(--vscode-descriptionForeground);line-height:1.5}'
    + '.file{margin:16px 20px;border:1px solid var(--vscode-panel-border,var(--vscode-editorGroup-border));border-radius:5px;overflow:hidden}'
    + 'h2{font-size:1em;overflow-wrap:anywhere;font-weight:600;margin:0;padding:10px 12px;background:var(--vscode-sideBarSectionHeader-background,var(--vscode-editorWidget-background));border-bottom:1px solid var(--vscode-panel-border,var(--vscode-editorGroup-border))}'
    + '.rows{overflow-x:hidden;font:var(--vscode-editor-font-size,12px)/1.6 var(--vscode-editor-font-family,monospace);tab-size:4}'
    + '.diff-line{display:grid;grid-template-columns:4.2em 4.2em 2em minmax(0,1fr);width:100%}'
    + '.line-number{padding:0 7px;text-align:right;user-select:none;color:var(--vscode-editorLineNumber-foreground);border-right:1px solid var(--vscode-panel-border,var(--vscode-editorGroup-border))}'
    + '.sign{padding-left:8px;user-select:none}.line-text{min-width:0;padding-right:20px;white-space:pre-wrap;overflow-wrap:anywhere}'
    + '.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(46,160,67,.15))}'
    + '.remove{background:var(--vscode-diffEditor-removedLineBackground,rgba(248,81,73,.15))}'
    + '.add .sign{color:var(--vscode-editorGutter-addedBackground,#3fb950)}'
    + '.remove .sign{color:var(--vscode-editorGutter-deletedBackground,#f85149)}'
    + '.add .changed-token{background:var(--vscode-diffEditor-insertedTextBackground,rgba(46,160,67,.35));border-radius:2px}'
    + '.remove .changed-token{background:var(--vscode-diffEditor-removedTextBackground,rgba(248,81,73,.35));border-radius:2px}'
    + '.hunk{background:var(--vscode-diffEditor-diagonalFill,transparent);color:var(--vscode-textLink-foreground);padding:4px 12px;white-space:pre-wrap;overflow-wrap:anywhere}'
    + '.meta{color:var(--vscode-descriptionForeground);padding:0 12px;font-style:italic}'
    + '</style></head><body><header class="intro"><h1>Spellchecks Performed</h1></header>'
    + (blocks || '<p style="padding:20px">There are no remaining unstaged spellcheck changes to display.</p>')
    + '</body></html>';
}

module.exports = { spellcheckDiffFiles, spellcheckChangeSpans, escapeHtml, parseUnifiedDiff, highlightChange, renderSpellcheckDiff };
