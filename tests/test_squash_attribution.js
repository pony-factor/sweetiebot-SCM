'use strict';
const assert=require('node:assert/strict');
const {squashMessage,readCommits}=require('../efs/squash_attribution');
async function run(){
 const commits=[{commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},committer:{name:'GitHub',email:'noreply@github.com'},message:'Change\n\nCo-authored-by: Codex <noreply@openai.com>'}},{commit:{author:{name:'John Wooten',email:'60260750+JFWooten4@users.noreply.github.com'},message:'Sync\n\nCo-authored-by: Codex Web <noreply@openai.com>'}}];
 const prepared=squashMessage('🐛 Repair retries',269,commits);
 assert.equal(prepared.title,'🐛 Repair retries (#269)');
 assert.deepEqual(prepared.trailers.map(s=>s.match(/^Co-authored-by: (.+?) </)[1]),['John Wooten','Codex','Codex Web']);
 assert.equal(prepared.message, [
  '- Change',
  '- Sync',
  '',
  '---------',
  '',
  'Co-authored-by: John Wooten <noreply@wooten.link>',
  'Co-authored-by: Codex <noreply@openai.com>',
  'Co-authored-by: Codex Web <noreply@openai.com>'
 ].join('\n'));
 const detailed=[
  {commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},message:'🖍️ Reference Austin Campbell TAD clip\r\n\r\nAdd a root-level reference to the personal clips index.\r\n\r\nMore context.\r\n\r\nCo-authored-by: Codex Web <noreply@openai.com>'}},
  {commit:{author:{name:'John Wooten',email:'60260750+JFWooten4@users.noreply.github.com'},message:'➕ Add IBM Redbooks reference\n\nCo-authored-by: Codex <noreply@openai.com>'}}
 ];
 const formatted=squashMessage('📝 Research DRS',67,detailed);
 assert.equal(formatted.message, [
  '- 🖍️ Reference Austin Campbell TAD clip',
  '  Add a root-level reference to the personal clips index.',
  '',
  '  More context.',
  '- ➕ Add IBM Redbooks reference',
  '',
  '---------',
  '',
  'Co-authored-by: John Wooten <noreply@wooten.link>',
  'Co-authored-by: Codex <noreply@openai.com>',
  'Co-authored-by: Codex Web <noreply@openai.com>'
 ].join('\n'));
 assert(!/(^|\n)\* /.test(formatted.message), 'Commit list must use hyphens, not asterisks');
 assert(!formatted.message.includes('\n\n\n'), 'No extra blank lines between entries');
 assert.equal((formatted.message.match(/^Co-authored-by:/gm)||[]).length,3,
  'Trailers appear only in one consolidated block');
 assert.throws(()=>squashMessage('Wrong',269,[{commit:{author:{name:'A',email:'a@example.org'},message:'\nNo subject'}}]),/subject/);

 assert.throws(()=>squashMessage('Wrong',269,[]),/history/);
 assert.throws(()=>squashMessage('Wrong',269,[{commit:{author:{}}}]),/Git author/);
 let calls=0;
 assert.equal((await readCommits(async()=>{calls++;return commits},'owner/repo',269)).length,2);
 assert.equal(calls,1);
 await assert.rejects(readCommits(async()=>({}),'owner/repo',269),/Invalid/);
}
run().catch(e=>{console.error(e);process.exitCode=1});
