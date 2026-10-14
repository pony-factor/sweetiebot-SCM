'use strict';
const assert=require('node:assert/strict');
const {squashMessage,readCommits}=require('../efs/squash_attribution');
async function run(){
 const commits=[{commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},committer:{name:'GitHub',email:'noreply@github.com'},message:'Change\n\nCo-authored-by: Codex <noreply@openai.com>'}},{commit:{author:{name:'John Wooten',email:'60260750+JFWooten4@users.noreply.github.com'},message:'Sync\n\nCo-authored-by: Codex Web <noreply@openai.com>'}}];
 const prepared=squashMessage('🐛 Repair retries',269,commits);
 assert.equal(prepared.title,'🐛 Repair retries (#269)');
 assert.deepEqual(prepared.trailers.map(s=>s.match(/^Co-authored-by: (.+?) </)[1]),['John Wooten','Codex','Codex Web']);
 assert.throws(()=>squashMessage('Wrong',269,[]),/history/);
 assert.throws(()=>squashMessage('Wrong',269,[{commit:{author:{}}}]),/Git author/);
 let calls=0;
 assert.equal((await readCommits(async()=>{calls++;return commits},'owner/repo',269)).length,2);
 assert.equal(calls,1);
 await assert.rejects(readCommits(async()=>({}),'owner/repo',269),/Invalid/);
}
run().catch(e=>{console.error(e);process.exitCode=1});
