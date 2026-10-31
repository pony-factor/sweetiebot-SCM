'use strict';
const assert=require('node:assert/strict');
const {SQUASH_SEPARATOR,SQUASH_SEPARATOR_STYLES,squashSeparatorForStyle,splitSquashTrailers,exactSquashTitle,squashMessage,readCommits}=require('../extension/merge/squash_attribution');
async function run(){
 const commits=[{commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},committer:{name:'GitHub',email:'noreply@github.com'},message:'Change\n\nCo-authored-by: Codex <noreply@openai.com>'}},{commit:{author:{name:'John Wooten',email:'60260750+JFWooten4@users.noreply.github.com'},message:'Sync\n\nCo-authored-by: Codex Web <noreply@openai.com>'}}];
 assert.equal(SQUASH_SEPARATOR, '__________');
 assert.equal(SQUASH_SEPARATOR.length, 10);
 assert.equal(exactSquashTitle('🖌️ Show final commit titles beside generation times', 393),
   '🖌️ Show final commit titles beside generation times (#393)');
 assert.equal(exactSquashTitle('🖌️ Show final commit titles beside generation times (#393)', 393),
   '🖌️ Show final commit titles beside generation times (#393)', 'Do not duplicate the exact suffix');
 assert.equal(exactSquashTitle('🖌️ Show final commit titles beside generation times (#42)', 393),
   '🖌️ Show final commit titles beside generation times (#42) (#393)',
   'Preserve the exact original PR title when it contains a different issue number');
 const prepared=squashMessage('🐛 Repair retries',269,commits);
 assert.equal(prepared.title,'🐛 Repair retries (#269)');
 const modeled=squashMessage('🔩 Verify co-authors',269,[{commit:{
   author:{name:'John Wooten',email:'noreply@wooten.link'},
   message:'Verify model\n\nCo-authored-by: Codex (6.1 Med) <noreply@openai.com>'
 }}]);
 assert(modeled.trailers.includes('Co-authored-by: Codex (6.1 Med, Web) <noreply@openai.com>'));
 assert.deepEqual(prepared.trailers.map(s=>s.match(/^Co-authored-by: (.+?) </)[1]),['John Wooten','Codex (Web)']);
 assert.equal(prepared.message, [
  '- Change',
  '- Sync',
  '',
  '__________',
  '',
  'Co-authored-by: John Wooten <noreply@wooten.link>',
  'Co-authored-by: Codex (Web) <noreply@openai.com>'
 ].join('\n'));
 const styles = { underscores:'__________', hyphens:'---------', none:'' };
 assert.deepEqual(SQUASH_SEPARATOR_STYLES,styles);
 for (const [style,divider] of Object.entries(styles)) {
   assert.equal(squashSeparatorForStyle(style),divider);
   const alternative=squashMessage('🐛 Repair retries',269,commits,{trailerSeparatorStyle:style});
   const trailer=alternative.trailers.join('\n');
   assert.equal(alternative.message,'- Change\n- Sync\n\n'+(divider?divider+'\n\n':'')+trailer);
   const sections=splitSquashTrailers(alternative.title+'\n\n'+alternative.message,style);
   assert.equal(sections.length,2);
   assert.equal(sections[1],trailer);
 }
 assert.throws(()=>squashSeparatorForStyle('invalid'),/Invalid squash trailer/);
 assert.throws(()=>squashMessage('🐛 Repair retries',269,commits,{trailerSeparatorStyle:'invalid'}),/Invalid squash trailer/);
 const detailed=[
  {commit:{author:{name:'John Wooten',email:'noreply@wooten.link'},message:'🖍️ Reference Austin Campbell TAD clip\r\n\r\nAdd a root-level reference to the personal clips index.\r\n\r\nMore context.\r\n\r\nCo-authored-by: Codex Web <noreply@openai.com>'}},
  {commit:{author:{name:'John Wooten',email:'60260750+JFWooten4@users.noreply.github.com'},message:'➕ Add IBM Redbooks reference\n\nCo-authored-by: Codex <noreply@openai.com>'}}
 ];
 const formatted=squashMessage('📝 Research DRS',67,detailed);
 assert.equal(formatted.message, [
  '- 🖍️ Reference Austin Campbell TAD clip',
  '',
  '        Add a root-level reference to the personal clips index.',
  '',
  '        More context.',
  '',
  '- ➕ Add IBM Redbooks reference',
  '',
  '__________',
  '',
  'Co-authored-by: John Wooten <noreply@wooten.link>',
  'Co-authored-by: Codex (Web) <noreply@openai.com>'
 ].join('\n'));
 const firstSeen=[
  {commit:{author:{name:'Mara Example',email:'mara@example.org'},
    message:'First\n\nCo-authored-by: John Wooten <noreply@wooten.link>\nCo-authored-by: Alice Example <alice@example.org>'}},
  {commit:{author:{name:'JOHN WOOTEN',email:'60260750+JFWooten4@users.noreply.github.com'},
    message:'Second\n\nCo-authored-by: mara example <mara+later@example.org>\nCo-authored-by: ALICE EXAMPLE <alice+later@example.org>'}},
  {commit:{author:{name:'Zoe Example',email:'zoe@example.org'},message:'Third'}}
 ];
 const chronological=squashMessage('🧪 Preserve first human attribution',270,firstSeen);
 assert.deepEqual(chronological.trailers,[
  'Co-authored-by: Mara Example <mara@example.org>',
  'Co-authored-by: John Wooten <noreply@wooten.link>',
  'Co-authored-by: Alice Example <alice@example.org>',
  'Co-authored-by: Zoe Example <zoe@example.org>',
  'Co-authored-by: Codex (Web) <noreply@openai.com>'
 ], 'Keep first-seen human order, name spelling and email despite later author or trailer matches');
 const excluded=squashMessage('🧪 Exclude primary human',270,firstSeen,
   {primaryAuthor:{name:'MARA EXAMPLE',email:'mara@example.org'}});
 assert.deepEqual(excluded.trailers,chronological.trailers.slice(1),
   'Removing the squash Git author must not reorder other contributors');
 assert(!/(^|\n)\* /.test(formatted.message), 'Commit list must use hyphens, not asterisks');
 assert(!formatted.message.includes('\n\n\n'), 'No extra blank lines between entries');
 assert.equal((formatted.message.match(/^Co-authored-by:/gm)||[]).length,2,
  'Trailers appear only in one consolidated block');
 assert.throws(()=>squashMessage('Wrong',269,[{commit:{author:{name:'A',email:'a@example.org'},message:'\nNo subject'}}]),/subject/);

 const {formatCommitBody} = require('../extension/merge/squash_attribution');
 const wrapped = formatCommitBody('A long description with meaningful context '.repeat(12));
 assert(wrapped.split('\n').every(line => line.length <= 88 && line.startsWith('        ')));
 assert.equal(wrapped.replace(/\s+/g, ' ').trim(), 'A long description with meaningful context '.repeat(12).trim());
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
 const pr393=squashMessage('🖌️ Show final commit titles beside generation times',393,[feature,syncCommit],
   {filterSyncCommitSummaries:true});
 assert.equal(pr393.title,'🖌️ Show final commit titles beside generation times (#393)');
 assert(pr393.message.includes('\n\n__________\n\n'));
 assert(!pr393.message.includes('---------'));
 assert(!pr393.message.includes('Sync brach to main'));
 const filtered=squashMessage('🖌️ Update merge settings',393,[feature,syncCommit,correctSpelling],{filterSyncCommitSummaries:true});
 assert(filtered.message.includes('- 🖌️ Update merge settings'));
 assert(!filtered.message.includes('Sync brach to main'));
 assert(!filtered.message.includes('Sync branch to main'));
 assert(!filtered.message.includes('latest request timeout changes'));
 assert(filtered.trailers.includes('Co-authored-by: Codex (Web) <noreply@openai.com>'),
   'Filtering sync summaries never loses co-author attribution');
 const unfiltered=squashMessage('🖌️ Update merge settings',393,[feature,syncCommit,correctSpelling],{filterSyncCommitSummaries:false});
 assert(unfiltered.message.includes('- 🔄 Sync brach to main'));
 assert(unfiltered.message.includes('- 🔄 Sync branch to main'));
 assert(unfiltered.message.includes('Keep the latest request timeout changes.'));
 for (const style of ['underscores','hyphens','none']) {
   const empty=squashMessage('🔧 Apply settings',394,[syncCommit],
     {filterSyncCommitSummaries:true,trailerSeparatorStyle:style});
   assert(empty.message.startsWith('Co-authored-by: '));
 }
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
 assert(emojiOnly.message.startsWith('🐛 Fix panel resizing\n\n        Avoid overflowing the viewport.\n\n🧪 Cover small windows'));
 assert(!emojiOnly.message.includes('- 🐛'));
 assert(!emojiOnly.message.includes('Sync brach to main'));
 assert(emojiOnly.trailers.includes('Co-authored-by: Codex (Web) <noreply@openai.com>'));
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
 const { validateCommitProposal } = require('../extension/merge/commit_proposal');
 const accepted = validateCommitProposal({ title: legacyBullets.title, message: legacyBullets.message }, legacyBullets);
 assert(accepted.proposed && !accepted.adjusted);
 const corrected = validateCommitProposal({ title: legacyBullets.title, message: 'An incomplete web proposal' }, legacyBullets);
 assert(corrected.adjusted); assert.equal(corrected.message, legacyBullets.message, 'Missing original content or credits are restored locally');
 assert.throws(() => validateCommitProposal({ title: 'Wrong PR title', message: legacyBullets.message }, legacyBullets), /exactly match/);
 await assert.rejects(readCommits(async()=>({}),'owner/repo',269),/Invalid/);
}
run().catch(e=>{console.error(e);process.exitCode=1});
