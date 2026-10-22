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

 const legacy=squashMessage('🛠️ Keep verified Ollama attribution',270,[{commit:{
  author:{name:'John Wooten',email:'noreply@wooten.link'},
  message:'Spellcheck\n\nCo-authored-by: Ollama <hello@ollama.com>\nCo-authored-by: Ollama (qwen2.5-coder:7b) <326443430+codex-pony[bot]@users.noreply.github.com>'
 }}]);
 assert(!legacy.message.includes('hello@ollama.com'), 'Obsolete Ollama placeholder must never enter a squash commit');
 assert(legacy.trailers.includes('Co-authored-by: Ollama (qwen2.5-coder:7b) <326443430+codex-pony[bot]@users.noreply.github.com>'));
 assert(!legacy.message.includes('Co-authored-by: Ollama <'));
 assert.throws(()=>squashMessage('Wrong',269,[]),/history/);
 assert.throws(()=>squashMessage('Wrong',269,[{commit:{author:{}}}]),/Git author/);
 const syncCommit={commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},
   message:'🔄 Sync brach to main\n\nKeep the latest request timeout changes.\n\nCo-authored-by: Codex <noreply@openai.com>'}};
 const correctSpelling={commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},
   message:'🔄 Sync branch to main\n\nUpdate from upstream.'}};
 const feature={commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},
   message:'🖌️ Update merge settings'}};
 const filtered=squashMessage('🖌️ Update merge settings',393,[feature,syncCommit,correctSpelling],{filterSyncCommitSummaries:true});
 assert(filtered.message.includes('- 🖌️ Update merge settings'));
 assert(!filtered.message.includes('Sync brach to main'));
 assert(!filtered.message.includes('Sync branch to main'));
 assert(!filtered.message.includes('latest request timeout changes'));
 assert(filtered.trailers.includes('Co-authored-by: Codex <noreply@openai.com>'),
   'Filtering sync summaries never loses co-author attribution');
 const unfiltered=squashMessage('🖌️ Update merge settings',393,[feature,syncCommit,correctSpelling],{filterSyncCommitSummaries:false});
 assert(unfiltered.message.includes('- 🔄 Sync brach to main'));
 assert(unfiltered.message.includes('- 🔄 Sync branch to main'));
 assert(unfiltered.message.includes('Keep the latest request timeout changes.'));
 const onlySync=squashMessage('🔧 Apply settings',394,[syncCommit],{filterSyncCommitSummaries:true});
 assert(!onlySync.message.includes('Sync brach to main'));
 assert(onlySync.message.startsWith('Co-authored-by: '),
   'An all-sync PR must retain co-author trailers without an empty separator');
 const emojiTitles=[
   {commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},message:'🐛 Fix panel resizing\n\nAvoid overflowing the viewport.'}},
   {commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},message:'🧪 Cover small windows'}},
   syncCommit
 ];
 const emojiOnly=squashMessage('🖌️ Improve resize handling',395,emojiTitles,
   {filterSyncCommitSummaries:true,omitBulletsForEmojiTitles:true});
 assert(emojiOnly.message.startsWith('🐛 Fix panel resizing\n  Avoid overflowing the viewport.\n\n🧪 Cover small windows'));
 assert(!emojiOnly.message.includes('- 🐛'));
 assert(!emojiOnly.message.includes('Sync brach to main'));
 assert(emojiOnly.trailers.includes('Co-authored-by: Codex <noreply@openai.com>'));
 const legacyBullets=squashMessage('🖌️ Improve resize handling',395,emojiTitles,
   {filterSyncCommitSummaries:true,omitBulletsForEmojiTitles:false});
 assert(legacyBullets.message.includes('- 🐛 Fix panel resizing'));
 assert(legacyBullets.message.includes('- 🧪 Cover small windows'));
 const mixed=squashMessage('🖌️ Improve resize handling',395,[...emojiTitles,
   {commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},message:'Document keyboard shortcuts'}}],
   {filterSyncCommitSummaries:true,omitBulletsForEmojiTitles:true});
 assert(mixed.message.includes('- 🐛 Fix panel resizing'));
 assert(mixed.message.includes('- Document keyboard shortcuts'));
 const includedSync=squashMessage('🖌️ Improve resize handling',395,emojiTitles,
   {filterSyncCommitSummaries:false,omitBulletsForEmojiTitles:true});
 assert(includedSync.message.includes('🔄 Sync brach to main'));
 assert(!includedSync.message.includes('- 🔄 Sync brach to main'));
 let calls=0;
 assert.equal((await readCommits(async()=>{calls++;return commits},'owner/repo',269)).length,2);
 assert.equal(calls,1);
 await assert.rejects(readCommits(async()=>({}),'owner/repo',269),/Invalid/);
}
run().catch(e=>{console.error(e);process.exitCode=1});
