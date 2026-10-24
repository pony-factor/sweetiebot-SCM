'use strict';

function commitTreeLayout(commits) {
  const nodes = [], bySha = new Map(), children = new Map();
  let lanes = 1;
  for (const commit of (commits || []).slice(-100)) {
    if (!/^[a-f0-9]{40}$/i.test(commit.sha || '')) continue;
    const parents = (commit.parents || []).map(parent => parent.sha).filter(sha => /^[a-f0-9]{40}$/i.test(sha || ''));
    const parent = bySha.get(parents[0]);
    const lane = parent && (children.get(parent.sha) || 0) === 0 ? parent.lane : parent ? lanes++ : 0;
    const node = { sha: commit.sha, parents, lane, row: nodes.length,
      title: String(commit.commit?.message || '').split('\n')[0] };
    for (const sha of parents) children.set(sha, (children.get(sha) || 0) + 1);
    nodes.push(node); bySha.set(node.sha, node);
  }
  return { nodes, lanes, edges: nodes.flatMap(node => node.parents.filter(sha => bySha.has(sha))
    .map(sha => ({ from: bySha.get(sha), to: node }))) };
}

function renderCommitTree(parent, commits, openCommit) {
  const document = parent.ownerDocument, graph = commitTreeLayout(commits);
  const heading = document.createElement('h3'); heading.textContent = 'PR commits'; parent.appendChild(heading);
  if (!graph.nodes.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Commit history not loaded yet.'; parent.appendChild(empty); return;
  }
  const list = document.createElement('div'); list.className = 'commit-tree-list'; parent.appendChild(list);
  const width = Math.min(84, 16 + graph.lanes * 16);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', width); svg.setAttribute('height', graph.nodes.length * 52); svg.setAttribute('aria-hidden', 'true');
  list.appendChild(svg);
  for (const edge of graph.edges) {
    const line = document.createElementNS(svg.namespaceURI, 'line');
    for (const [key, value] of Object.entries({ x1: 12 + edge.from.lane * 16, y1: edge.from.row * 52 + 17,
      x2: 12 + edge.to.lane * 16, y2: edge.to.row * 52 + 17 })) line.setAttribute(key, value);
    svg.appendChild(line);
  }
  for (const node of graph.nodes) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    circle.setAttribute('cx', 12 + node.lane * 16); circle.setAttribute('cy', node.row * 52 + 17); circle.setAttribute('r', 4); svg.appendChild(circle);
    const button = document.createElement('button'); button.className = 'commit-tree-item'; button.style.marginLeft = width + 'px';
    button.textContent = node.sha.slice(0, 7) + ' ' + node.title; button.title = node.sha + '\n' + node.title;
    button.addEventListener('click', () => openCommit(node.sha)); list.appendChild(button);
  }
}
if (typeof module === 'object' && module.exports) module.exports = { commitTreeLayout, renderCommitTree };
