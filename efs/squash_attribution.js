'use strict';

// One canonical separator for all generated PR squash-commit trailers.
const SQUASH_SEPARATOR = '__________';
const { execFileSync } = require('node:child_process');
const SYNC_MAIN_SUBJECT = /^(?:🔄\s*)?Sync (?:brach|branch) to main(?:\s*\(#\d+\))?$/i;
function filterSyncCommitSummariesEnabled() {
  try {
    return execFileSync('git', ['config', '--global', '--type=bool', '--get',
      'scm-toolkit.filter-sync-commit-summaries'], { encoding: 'utf8', timeout: 3000 }).trim() !== 'false';
  } catch {
    return true;
  }
}
const EMOJI_PREFIX = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u;
function omitBulletsForEmojiTitlesEnabled() {
  try {
    return execFileSync('git', ['config', '--global', '--type=bool', '--get',
      'scm-toolkit.squash-omit-bullets-for-emoji-titles'],
      { encoding: 'utf8', timeout: 3000 }).trim() === 'true';
  } catch {
    return false;
  }
}
const COAUTHOR=/^Co-authored-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/gim;
function who(name,email,original=false) {
 if(typeof name!=='string'||!name.trim()||/[<>\r\n]/.test(name)||typeof email!=='string'||!/^[^\s<>]+@[^\s<>]+$/.test(email)) return null;
 // A historical Ollama placeholder is not a verified account-linked co-author.
 if(email.trim().toLowerCase()==='hello@ollama.com') return null;
 const id=(name+' '+email).toLowerCase();
 const tier=/^codex$/i.test(name)?2:/^codex web$/i.test(name)?3:/codex-pony/.test(id)?4:/copilot/.test(id)?5:/ollama/.test(id)?6:/\[bot\]|bot@|dependabot|github.actions|web-flow/.test(id)?7:/openai|claude|gemini|ai.agent/.test(id)?8:original?0:1;
 return {name:name.trim(),email:email.trim(),tier};
}
function exactSquashTitle(title, num) {
 if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title) ||
     !Number.isSafeInteger(num) || num < 1) throw Error('Invalid squash title');
 const originalTitle = title.trim();
 const suffix = ' (#' + num + ')';
 return originalTitle.endsWith(suffix) ? originalTitle : originalTitle + suffix;
}
function squashMessage(title,num,commits,{primaryAuthor,filterSyncCommitSummaries=filterSyncCommitSummariesEnabled(),omitBulletsForEmojiTitles=omitBulletsForEmojiTitlesEnabled()}={}){
 const finalTitle = exactSquashTitle(title, num);
 if(!Array.isArray(commits)||!commits.length) throw Error('Original PR commit history unavailable');
 const names=new Map();
 const summaries=[];
 const add=p=>{if(p&&(!names.has(p.name.toLowerCase())||p.tier<names.get(p.name.toLowerCase()).tier))names.set(p.name.toLowerCase(),p)};
 for(const entry of commits){
   const original=who(entry?.commit?.author?.name,entry?.commit?.author?.email,true);
   if(!original) throw Error('Original human or bot Git author could not be verified');
   add(original);
   const c=entry?.commit?.committer;
   if(!/^github$/i.test(c?.name||''))add(who(c?.name,c?.email));
   const message=String(entry?.commit?.message||'').replace(/\r\n?/g,'\n');
   for(const m of message.matchAll(COAUTHOR))add(who(m[1],m[2]));
   const [subject,...bodyLines]=message.split('\n');
   if(!subject.trim())throw Error('Original PR commit subject unavailable');
   const body=bodyLines.join('\n').replace(COAUTHOR,'').trim();
   if (!(filterSyncCommitSummaries && SYNC_MAIN_SUBJECT.test(subject.trim()))) {
     summaries.push('- '+subject.trim()+(body?'\n'+body.split('\n').map(line=>line?'  '+line:'').join('\n'):''));
   }
 }
 add(who('Codex Web','noreply@openai.com'));
 // The actual squash Git author is never repeated as a Co-authored-by trailer.
 const trailers=[...names.values()].filter(p=>!primaryAuthor || p.name.toLowerCase()!==primaryAuthor.name.toLowerCase())
   .sort((a,b)=>a.tier-b.tier).map(p=>'Co-authored-by: '+p.name+' <'+p.email+'>');
 const unbulleted = omitBulletsForEmojiTitles && summaries.length > 0 &&
   summaries.every(summary => EMOJI_PREFIX.test(summary.slice(2).split('\n', 1)[0]));
 const summaryText = summaries.map(summary => unbulleted ? summary.slice(2) : summary)
   .join(unbulleted ? '\n\n' : '\n');
 return {title:finalTitle,message:(summaries.length?summaryText+'\n\n'+SQUASH_SEPARATOR+'\n\n':'')+trailers.join('\n'),trailers};
}
async function readCommits(api,repo,num){
 const all=[];
 for(let page=1;page<=100;page++){
   const part=await api(['repos/'+repo+'/pulls/'+num+'/commits?per_page=100&page='+page]);
   if(!Array.isArray(part))throw Error('Invalid original PR commit history');
   all.push(...part);
   if(part.length<100)return all;
 }
 throw Error('Cannot inspect complete PR history');
}
module.exports={SQUASH_SEPARATOR,exactSquashTitle,squashMessage,readCommits};
