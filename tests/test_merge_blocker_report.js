'use strict';
const assert = require('node:assert/strict');
const { publishBlockerReport, firstDiffAnchor } = require('../efs/merge_blocker_report');
const { blockerOptions } = require('../efs/merge_blocker_actions');
const pr = { number: 68, title: 'Feature', headSha: 'a'.repeat(40), head: 'feature', base: 'main' };
assert.deepEqual(firstDiffAnchor('@@ -4 +4,2 @@\n context\n+new'), { line: 5, side: 'RIGHT' });
assert.equal(firstDiffAnchor('not a patch'), null);
(async () => {
  let writes = [], comments = [], moved = false;
  const paths = ['options.html','options.js'];
  const decisions = [
    {path:paths[0],title:'Retain the independent checkboxes',description:'Main adds sidebar controls. The PR adds heading controls. Keep both sets under the existing section with distinct IDs; neither replaces the other.'},
    {path:paths[1],title:'Wire all settings through persistence',description:'Main and the PR add separate storage keys. Retain each default, load/save assignment, and listener so toggling either preference survives reopening.'}
  ];
  const api = async (endpoint, options) => {
    if (options) {
      writes.push({endpoint,...options});
      const existing = comments.find(c => endpoint === 'repos/o/r/pulls/comments/'+c.id);
      if(existing) existing.body=options.body.body;
      else { assert.equal(endpoint,'repos/o/r/pulls/68/comments'); comments.push({id:comments.length+1,path:options.body.path,user:{login:'me'},body:options.body.body}); }
      return {html_url:'https://github.com/o/r/pull/68#discussion_r'+comments.length};
    }
    if (endpoint === 'user') return {login:'me'};
    if (endpoint.includes('/branches/')) return {commit:{sha:'b'.repeat(40)}};
    if (endpoint.includes('/files?')) return paths.map(filename=>({filename,patch:'@@ -4 +4,2 @@\n context\n+new'}));
    if (endpoint.includes('/comments?')) return comments;
    return {state:'open',title:pr.title,head:{sha:moved?'c'.repeat(40):pr.headSha,ref:pr.head},base:{ref:pr.base}};
  };
  const run = extra => publishBlockerReport({repository:'o/r',pr,reason:'Patch error',paths,api,...extra});
  const empty=await run(); assert(!empty.posted); assert.equal(writes.length,0,'Do not turn file names into fabricated analysis or choices');
  assert.deepEqual(blockerOptions({state:'conflict'}),[],'Preserving both intentions is automatic, not a generic choice');
  assert((await run({decisions})).posted);
  assert.equal(writes.length,2,'Each substantive file gets its own code comment');
  assert.equal(writes[0].body.line,5); assert.equal(writes[0].body.commit_id,pr.headSha);
  assert(writes[0].body.body.includes(decisions[0].description));
  assert(!writes[0].body.body.includes('sweetiebot-merge-options'),'Compatible changes do not request reaction approval');
  assert((await run({decisions})).posted); assert.equal(writes[2].method,'PATCH');
  assert.equal(writes[2].endpoint,'repos/o/r/pulls/comments/1','Use the actual GitHub review-comment update endpoint');
  comments[0].body='<!-- sweetiebot-merge-review -->\n### Automatic integration stopped\nOld generic choices';
  assert((await run({decisions})).posted); assert(!comments[0].body.includes('Automatic integration stopped'),'Replace legacy boilerplate in place');
  moved=true;
  const stopped=await run({decisions}); assert(!stopped.posted); assert.equal(stopped.notes.length,2,'Substantive local explanations survive GitHub publication failure');
  assert.equal(writes.length,6,'Never post against a changed head');
  console.log('Per-file analysis, real anchors, legacy replacement and snapshot checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
