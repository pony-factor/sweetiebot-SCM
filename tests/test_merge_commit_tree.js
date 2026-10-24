'use strict';
const assert = require('node:assert/strict');
const {commitTreeLayout,renderCommitTree,refreshCommitTimestamps} = require('../efs/merge_commit_tree');
const {formatTimelineTimestamp} = require('../efs/merge_dashboard_timestamps');
const a='a'.repeat(40), b='b'.repeat(40), c='c'.repeat(40);
const commits=[
  {sha:a,parents:[],commit:{message:'First',author:{date:'2026-10-23T10:00:00Z'},committer:{date:'2026-10-24T10:00:00Z'}}},
  {sha:b,parents:[{sha:a}],commit:{message:'Second',committer:{date:'bad'},author:{date:'2026-10-24T10:30:00Z'}}},
  {sha:c,parents:[{sha:b}],commit:{message:'No timestamp'}}
];
const layout=commitTreeLayout(commits);
assert.equal(layout.nodes.find(n=>n.sha===a).committedAt,'2026-10-24T10:00:00Z','Prefer the Git committer timestamp');
assert.equal(layout.nodes.find(n=>n.sha===b).committedAt,'2026-10-24T10:30:00Z','Use author time when committer metadata is invalid');
const elements=[];
const document={
  createElement(tag){const node={tag,ownerDocument:document,children:[],style:{},dataset:{},events:{},attributes:{},appendChild(child){this.children.push(child);},setAttribute(key,value){this.attributes[key]=value;},addEventListener(type,fn){this.events[type]=fn;},querySelectorAll(){return elements.filter(n=>n.tag==='time'&&n.dataset.commitAt);}};elements.push(node);return node;},
  createElementNS(ns,tag){const node=this.createElement(tag);node.namespaceURI=ns;return node;}
};
const originalNow=Date.now;
Date.now=()=>Date.parse('2026-10-24T11:00:00Z');
try {
  const parent=document.createElement('section'), opened=[];
  renderCommitTree(parent,commits,sha=>opened.push(sha),'relative');
  const first=elements.find(n=>n.tag==='button'&&n.title.startsWith(a));
  assert.equal(first.children[1].textContent,'1h ago');
  assert(first.children[1].title.startsWith('Committed '));
  first.events.click();assert.deepEqual(opened,[a]);
  assert.equal(elements.find(n=>n.tag==='button'&&n.title.startsWith(c)).children[1].textContent,'Time unavailable');
  Date.now=()=>Date.parse('2026-10-24T12:00:00Z');refreshCommitTimestamps(parent,'relative');
  assert.equal(first.children[1].textContent,'2h ago');
  const clockParent=document.createElement('section');renderCommitTree(clockParent,[commits[0]],()=>{},'clock');
  assert.equal(elements.at(-1).textContent,formatTimelineTimestamp('2026-10-24T10:00:00Z','clock'));
  assert.equal(elements.find(n=>n.tag==='svg').attributes.height,156,'Timestamp rows preserve graph spacing');
} finally {Date.now=originalNow;}
console.log('PR commit timestamps, date fallback, relative refresh, links, and graph spacing passed.');
