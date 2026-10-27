'use strict';
const assert = require('node:assert/strict');
const { commitTreeLayout, renderCommitTree, mergeCommitHistory } = require('../extension/merge/merge_commit_tree');
const sha = digit => digit.repeat(40);
const node = (digit, parents) => ({ sha: sha(digit), parents: parents.map(digit => ({ sha: sha(digit) })), commit: { message: 'Commit ' + digit } });
const graph = commitTreeLayout([node('a', []), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])]);
assert.equal(graph.edges.length, 4, 'Draw actual parents, including both merge parents');
assert.deepEqual(graph.nodes.map(n => n.sha), ['d','c','b','a'].map(sha), 'Newest commit is at the top, earliest at the bottom');
assert(graph.edges.every(edge => edge.from.row > edge.to.row), 'Parent connections extend downward toward earlier commits');
assert.equal(graph.nodes.find(n=>n.sha===sha('b')).lane, graph.nodes.find(n=>n.sha===sha('a')).lane);
assert.notEqual(graph.nodes.find(n=>n.sha===sha('c')).lane, graph.nodes.find(n=>n.sha===sha('b')).lane, 'A fork gets its own lane');
assert.equal(commitTreeLayout([node('b', ['a'])]).edges.length, 0, 'Do not invent an unavailable parent node');
assert.equal(commitTreeLayout([{ sha: '../unsafe' }]).nodes.length, 0);
const many=Array.from({length:180},(_,i)=>({sha:i.toString(16).padStart(40,'0'),commit:{message:'Commit '+i},parents:[]}));
assert.equal(commitTreeLayout(many).nodes.length,180,'Show all PR commits, not only the latest 100');
const first=mergeCommitHistory([], [node('a',[]),node('b',['a'])]);
const next=mergeCommitHistory(first,[node('b',['a']),node('c',['b'])]);
assert.deepEqual(next.map(c=>c.sha),[sha('a'),sha('b'),sha('c')],'Keep original commits when a later head omits them');
assert.deepEqual(next.map(c=>c.isNew),[false,false,true]);
// Abbreviated hashes get inline-code styling; preserve the title and commit link.
const document = {
  createElement(tag) {
    return {
      tag, children: [], style: {}, listeners: {},
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(event, callback) { this.listeners[event] = callback; },
      set textContent(value) { this.text = String(value); this.children = []; },
      get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); }
    };
  },
  createElementNS(namespaceURI, tag) {
    return { tag, namespaceURI, children: [], attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(child) { this.children.push(child); } };
  }
};
const root = document.createElement('section'); root.ownerDocument = document;
const clicked = [];
renderCommitTree(root, [{ ...node('a', []), isNew: true }], hash => clicked.push(hash));
const list = root.children.find(child => child.className === 'commit-tree-list');
const button = list.children.find(child => child.tag === 'button');
const code = button.children.find(child => child.tag === 'code');
assert.equal(code.className, 'commit-tree-sha');
assert.equal(code.textContent, 'aaaaaaa');
assert.equal(button.textContent, 'New · aaaaaaa Commit a');
assert.equal(button.title, sha('a') + '\nCommit a');
button.listeners.click();
assert.deepEqual(clicked, [sha('a')], 'Code-styled SHA rows still open their full commit');
assert(require('node:fs').readFileSync(require('node:path').join(__dirname, '../extension/merge/merge_dashboard.html'), 'utf8')
  .includes('.commit-tree-sha{display:inline-block'), 'The SHA has dedicated code styling');
console.log('Commit tree parent, fork, merge, missing-parent and code hash checks passed.');
