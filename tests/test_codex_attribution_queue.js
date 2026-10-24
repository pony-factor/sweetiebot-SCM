'use strict';
const assert = require('node:assert/strict');
const {registerCodexCommitCommand} = require('../efs/codex_commit');

async function run() {
  const commands = new Map(), calls = [];
  const root = { scheme:'file', fsPath:'/repository', toString:()=>'/repository' };
  const repository = {rootUri:root, inputBox:{value:''}};
  const vscode = {
    Uri:{from:v=>v},
    extensions:{getExtension:id=>id==='vscode.git'
      ? {activate:async()=>({getAPI:()=>({getRepository:()=>repository})})} : undefined},
    commands:{
      registerCommand:(id,fn)=>{commands.set(id,fn);return {dispose(){}};},
      getCommands:async()=>[],
      executeCommand:async(id,uri,value)=>{
        if(id!=='sweetiebot.queueCommit')throw Error('Unexpected command '+id);
        calls.push(value);return {queued:true};
      }
    },
    workspace:{getConfiguration:section=>({get:key=>{
      if(section==='scmToolkit'&&key==='durableBackgroundCommits')return true;
      if(section==='git'&&key==='postCommitCommand')return 'none';
      return undefined;
    }})}
  };
  registerCodexCommitCommand(vscode,{subscriptions:[]});
  const commit=commands.get('sweetiebot.commitWithCodex');
  const basic='Co-authored-by: Codex <noreply@openai.com>';
  const web='Co-authored-by: Codex Web <noreply@openai.com>';
  await commit(root,{message:'Fix\n\n'+web,trailer:basic});
  assert.equal(calls[0].message,'Fix\n\nCo-authored-by: Codex (Web) <noreply@openai.com>');
  assert.equal(calls[0].trailer,'','Do not append an obsolete unmerged trailer again');
  await commit(root,{message:'',trailer:basic,codexCommitContext:true});
  assert.equal(calls[1].message,'');
  assert.equal(calls[1].trailer,basic,'Generated titles still receive the trailer');
  await commit(root,{message:'Fix again',trailer:basic});
  assert.equal(calls[2].message,'Fix again\n\n'+basic);
  assert.equal(calls[2].trailer,'');
  console.log('Durable Codex trailer consolidation checks passed');
}
run().catch(error=>{console.error(error);process.exitCode=1});

