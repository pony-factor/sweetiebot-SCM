'use strict';
const COAUTHOR=/^Co-authored-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/gim;
function who(name,email,original=false) {
 if(typeof name!=='string'||!name.trim()||/[<>\r\n]/.test(name)||typeof email!=='string'||!/^[^\s<>]+@[^\s<>]+$/.test(email)) return null;
 // A historical Ollama placeholder is not a verified account-linked co-author.
 if(email.trim().toLowerCase()==='hello@ollama.com') return null;
 const id=(name+' '+email).toLowerCase();
 const tier=/^codex$/i.test(name)?2:/^codex web$/i.test(name)?3:/codex-pony/.test(id)?4:/copilot/.test(id)?5:/ollama/.test(id)?6:/\[bot\]|bot@|dependabot|github.actions|web-flow/.test(id)?7:/openai|claude|gemini|ai.agent/.test(id)?8:original?0:1;
 return {name:name.trim(),email:email.trim(),tier};
}
function squashMessage(title,num,commits,{primaryAuthor}={}){
 if(typeof title!=='string'||!title.trim()||/[\r\n]/.test(title)||!Number.isSafeInteger(num)||num<1) throw Error('Invalid squash title');
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
   summaries.push('- '+subject.trim()+(body?'\n'+body.split('\n').map(line=>line?'  '+line:'').join('\n'):''));
 }
 add(who('Codex Web','noreply@openai.com'));
 // The actual squash Git author is never repeated as a Co-authored-by trailer.
 const trailers=[...names.values()].filter(p=>!primaryAuthor || p.name.toLowerCase()!==primaryAuthor.name.toLowerCase())
   .sort((a,b)=>a.tier-b.tier).map(p=>'Co-authored-by: '+p.name+' <'+p.email+'>');
 return {title:title.trim().replace(/\s*\(#\d+\)\s*$/,'').trim()+' (#'+num+')',message:summaries.join('\n')+'\n\n---------\n\n'+trailers.join('\n'),trailers};
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
module.exports={squashMessage,readCommits};
