'use strict';

// Render GitHub's unified patch as inert text nodes with VS Code-themeable line kinds.
function classifyMergePatchLine(line) {
  if (line.startsWith('@@')) return 'hunk';
  if (/^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |rename from |rename to |similarity index |dissimilarity index )/.test(line)) return 'meta';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.startsWith('\\ No newline at end of file')) return 'note';
  return 'context';
}
function renderMergePatch(pre, patch) {
  const doc = pre.ownerDocument;
  const lines = String(patch || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // A final newline is not an extra diff line.
  for (const line of lines) {
    const kind = classifyMergePatchLine(line);
    const row = doc.createElement('span');
    row.className = 'diff-line diff-line--' + kind;
    if (kind === 'added' || kind === 'removed') {
      const prefix = doc.createElement('span');
      prefix.className = 'diff-line-prefix';
      prefix.textContent = line[0];
      row.appendChild(prefix);
      const content = doc.createElement('span');
      content.className = 'diff-line-text';
      content.textContent = line.slice(1);
      row.appendChild(content);
    } else row.textContent = line;
    pre.appendChild(row);
  }
}
if (typeof module === 'object' && module.exports) module.exports = {
  classifyMergePatchLine, renderMergePatch
};
