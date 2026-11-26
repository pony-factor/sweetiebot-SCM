'use strict';
const assert = require('node:assert/strict');
const {registerCodexCommitCommand} = require('../../../extension/commits/codex/manual');

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
      if(section==='sweetiebot'&&key==='durableBackgroundCommits')return true;
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
  let modelReads = 0, selectedModel = {name:'GPT-6',effort:'Medium'};
  const originalExtension = vscode.extensions.getExtension;
  vscode.extensions.getExtension = id => id === 'openai.chatgpt'
    ? {isActive:true} : originalExtension(id);
  vscode.commands.getCommands = async () => ['sweetiebot.readCodexModel'];
  const execute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (id, ...args) => {
    if (id === 'sweetiebot.readCodexModel') { modelReads++; return selectedModel; }
    return execute(id, ...args);
  };
  await commit(root,{message:'Integer model',trailer:basic});
  assert.equal(calls.at(-1).message,'Integer model\n\nCo-authored-by: Codex (6 Med) <noreply@openai.com>');
  selectedModel = {name:'GPT-6.1',effort:'High'};
  await commit(root,{message:'Changed model',trailer:basic});
  assert.equal(calls.at(-1).message,'Changed model\n\nCo-authored-by: Codex (6.1 High) <noreply@openai.com>');
  assert.equal(modelReads,2,'Each commit must read the current composer model');
  const custom = 'Co-authored-by: Codex <other@example.org>';
  await commit(root,{message:'Custom identity',trailer:custom});
  assert.equal(calls.at(-1).message,'Custom identity\n\n'+custom);
  assert.equal(modelReads,2,'Do not label unrelated identities with the Codex model');
  console.log('Durable Codex trailer consolidation checks passed');
}
run().catch(error=>{console.error(error);process.exitCode=1});
