'use strict';
const assert = require('node:assert/strict');
const { publishBlockerReport, firstDiffAnchor } = require('../extension/merge/merge_blocker_report');
const { blockerOptions } = require('../extension/merge/merge_blocker_actions');
const pr = { number: 68, title: 'Feature', headSha: 'a'.repeat(40), head: 'feature', base: 'main' };
assert.deepEqual(firstDiffAnchor('@@ -4 +4,2 @@\n context\n+new'), { line: 5, side: 'RIGHT' });
assert.equal(firstDiffAnchor('not a patch'), null);
(async () => {
  let writes = [], comments = [], reviews = [], moved = false;
  const paths = ['options.html','options.js'];
  let decisions = [
    {path:paths[0],title:'Retain the independent checkboxes',description:'Main adds sidebar controls. The PR adds heading controls. Keep both sets under the existing section with distinct IDs; neither replaces the other.'},
    {path:paths[1],title:'Wire all settings through persistence',description:'Main and the PR add separate storage keys. Retain each default, load/save assignment, and listener so toggling either preference survives reopening.'}
  ];
  const api = async (endpoint, options) => {
    if (options) {
      writes.push({endpoint,...options});
      if (endpoint === 'repos/o/r/pulls/68/reviews') {
        const review={id:50,commit_id:pr.headSha,user:{login:'me'},body:options.body.body,html_url:'https://github.com/o/r/pull/68#pullrequestreview-50'};
        reviews.push(review);
        comments=options.body.comments.map((note,i)=>({...note,id:i+1,pull_request_review_id:50,user:{login:'me'},reactions:{total_count:0}}));
        return review;
      }
      if (endpoint === 'repos/o/r/pulls/68/reviews/50') {reviews[0].body=options.body.body;return reviews[0];}
      const existing=comments.find(c=>endpoint==='repos/o/r/pulls/comments/'+c.id);
      assert(existing);
      if(options.method==='DELETE'){comments=comments.filter(c=>c!==existing);return null;}
      existing.body=options.body.body;
      return {html_url:'https://github.com/o/r/pull/68#discussion_r'+existing.id};
    }
    if (endpoint === 'user') return {login:'me'};
    if (endpoint.includes('/branches/')) return {commit:{sha:'b'.repeat(40)}};
    if (endpoint.includes('/files?')) return paths.map(filename=>({filename,patch:'@@ -4 +4,2 @@\n context\n+new'}));
    if (endpoint.includes('/comments?')) return comments;
    if (endpoint.includes('/reviews?')) return reviews;
    return {state:'open',title:pr.title,head:{sha:moved?'c'.repeat(40):pr.headSha,ref:pr.head},base:{ref:pr.base}};
  };
  const run = extra => publishBlockerReport({repository:'o/r',pr,reason:'Patch error',paths,api,...extra});
  const empty=await run(); assert(!empty.posted); assert.equal(writes.length,0,'Do not turn file names into fabricated analysis or choices');
  assert.deepEqual(blockerOptions({state:'conflict'}),[],'Preserving both intentions is automatic, not a generic choice');
  assert(!(await run({decisions})).posted, 'Routine compatible integration stays local');
  assert(!(await run({decisions, kind:'human_review'})).posted, 'No invented choice when there are no distinct implementations');
  assert.equal(writes.length, 0);
  decisions = decisions.map(note => ({ ...note, description: note.description + '\n\n<!-- sweetiebot-merge-options\n' + JSON.stringify({
    version:1, headSha:pr.headSha, baseSha:'b'.repeat(40), options:[
      {id:'shared-settings',label:'Share the existing settings',prompt:'Use the existing shared storage keys for both controls.'},
      {id:'isolated-settings',label:'Keep settings independent',prompt:'Give the two controls separate storage keys and defaults.'}
    ]
  }) + '\n-->' }));
  assert((await run({decisions, kind:'human_review'})).posted);
  assert.equal(writes.length,1,'One review groups every file comment under its summary');
  assert.equal(writes[0].body.comments.length,2);
  assert.equal(writes[0].body.body, '<!-- sweetiebot-merge-analysis-review -->\n'
    + '`options.html`: Keep both sets under the existing section with distinct IDs; neither replaces the other.\n\n'
    + '`options.js`: Retain each default, load/save assignment, and listener so toggling either preference survives reopening.');
  assert(!writes[0].body.body.includes(pr.title), 'The review summary does not repeat the PR title');
  assert.equal(writes[0].body.comments[0].line,5); assert.equal(writes[0].body.commit_id,pr.headSha);
  assert(writes[0].body.comments[0].body.includes(decisions[0].description));
  assert(!writes[0].body.body.includes('sweetiebot-merge-options'), 'Structured choice metadata stays out of the summary');
  assert(writes[0].body.comments.every(note => note.body.includes('sweetiebot-merge-options') && note.body.includes('<!-- sweetiebot-merge-review -->')), 'Real decisions expose selectable choices to Lindsey');
  assert((await run({decisions, kind:'human_review'})).posted);
  assert.equal(writes[1].method,'PUT','Update the same review summary');
  assert.equal(writes[2].method,'PATCH');
  assert.equal(writes[2].endpoint,'repos/o/r/pulls/comments/1','Update the existing inline comment in the grouped review');
  comments[0].body='<!-- sweetiebot-merge-review -->\n### Automatic integration stopped\nOld generic choices';
  assert((await run({decisions, kind:'human_review'})).posted); assert(!comments[0].body.includes('Automatic integration stopped'),'Replace legacy boilerplate in place');
  const stale = decisions.map(note => ({...note,description:note.description.replace('b'.repeat(40),'c'.repeat(40))}));
  assert(!(await run({decisions:stale, kind:'human_review'})).posted, 'Stale choices never publish against a newer base');
  moved=true;
  const stopped=await run({decisions, kind:'human_review'}); assert(!stopped.posted); assert.equal(stopped.notes.length,2,'Substantive local explanations survive GitHub publication failure');
  assert.equal(writes.length,7,'Never post against a changed head');
  console.log('Per-file analysis, real anchors, legacy replacement and snapshot checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
