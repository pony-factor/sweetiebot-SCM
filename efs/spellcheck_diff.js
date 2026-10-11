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

function highlightChange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start
      && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  function render(text) {
    const finish = text.length - end;
    return escapeHtml(text.slice(0, start))
      + (finish > start ? '<span class="changed-token">' + escapeHtml(text.slice(start, finish)) + '</span>' : '')
      + escapeHtml(text.slice(finish));
  }
  return [render(before), render(after)];
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
    + '.rows{overflow-x:auto;font:var(--vscode-editor-font-size,12px)/1.6 var(--vscode-editor-font-family,monospace);tab-size:4}'
    + '.diff-line{display:grid;grid-template-columns:4.2em 4.2em 2em minmax(max-content,1fr);min-width:100%;width:max-content;white-space:pre}'
    + '.line-number{padding:0 7px;text-align:right;user-select:none;color:var(--vscode-editorLineNumber-foreground);border-right:1px solid var(--vscode-panel-border,var(--vscode-editorGroup-border))}'
    + '.sign{padding-left:8px;user-select:none}.line-text{padding-right:20px;white-space:pre}'
    + '.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(46,160,67,.15))}'
    + '.remove{background:var(--vscode-diffEditor-removedLineBackground,rgba(248,81,73,.15))}'
    + '.add .sign{color:var(--vscode-editorGutter-addedBackground,#3fb950)}'
    + '.remove .sign{color:var(--vscode-editorGutter-deletedBackground,#f85149)}'
    + '.add .changed-token{background:var(--vscode-diffEditor-insertedTextBackground,rgba(46,160,67,.35));border-radius:2px}'
    + '.remove .changed-token{background:var(--vscode-diffEditor-removedTextBackground,rgba(248,81,73,.35));border-radius:2px}'
    + '.hunk{background:var(--vscode-diffEditor-diagonalFill,transparent);color:var(--vscode-textLink-foreground);padding:4px 12px;white-space:pre}'
    + '.meta{color:var(--vscode-descriptionForeground);padding:0 12px;font-style:italic}'
    + '</style></head><body><header class="intro"><h1>' + escapeHtml(title || 'Spellcheck suggestions') + '</h1>'
    + '<p>All proposed edits are unstaged in Source Control. Click outside this preview to close it; review, stage, or discard edits in SCM.</p></header>'
    + (blocks || '<p style="padding:20px">There are no remaining unstaged spellcheck changes to display.</p>')
    + '</body></html>';
}

module.exports = { escapeHtml, parseUnifiedDiff, highlightChange, renderSpellcheckDiff };
