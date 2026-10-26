'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {safeFilenameSuggestion, changedFileUris, repoForPath, proposeFilename, spellcheckFilenames} = require('../efs/commits/filename_spellcheck');

test('filename spelling preserves extensions, punctuation, paths and structural tokens', () => {
  assert.equal(safeFilenameSuggestion('finra-droppn.wd', 'finra-dropping.wd'), true);
  assert.equal(safeFilenameSuggestion('legal-arugment.md', 'legal-argument.md'), true);
  assert.equal(safeFilenameSuggestion('notes_a1.md', 'notes_b1.md'), true); // model proposals require review
  for (const candidate of ['finra-dropping.md', '../finra-dropping.wd', 'finra/dropping.wd',
    'finra_dropping.wd', 'finra-dropping-2.wd', 'finra-droppn.wd',
    'finra-dropping.wd\nInjected', '.finra-dropping.wd']) {
    assert.equal(safeFilenameSuggestion('finra-droppn.wd', candidate), false, candidate);
  }
  assert.equal(safeFilenameSuggestion('.env', '.even'), false);
});

test('uses changed files from SCM and includes untracked non-Markdown filenames', () => {
  const repo = {rootUri:{fsPath:'/repo'},state:{workingTreeChanges:[{uri:{fsPath:'/repo/new-droppn.wd'}}],
    indexChanges:[{resourceUri:{fsPath:'/repo/staged-wrod.pdf'}}],
    untrackedChanges:[{uri:{fsPath:'/repo/new-droppn.wd'}}]}};
  assert.deepEqual(changedFileUris([repo]).map(u=>u.fsPath), ['/repo/new-droppn.wd','/repo/staged-wrod.pdf']);
  assert.deepEqual(changedFileUris([repo], {resourceUri:{fsPath:'/repo/direct-wrod.md'}}).map(u=>u.fsPath), ['/repo/direct-wrod.md']);
  assert.equal(repoForPath([repo], '/repo/new-droppn.wd'), repo);
  assert.equal(repoForPath([repo], '/different/place.md'), undefined);
});

test('rejects unsafe model outputs without renaming anything', async () => {
  const ask = async (_url, _endpoint, options) => {
    assert.match(options.prompt, /finra-droppn\.wd/);
    return {response: JSON.stringify({filename:'finra-dropping.wd'})};
  };
  assert.equal(await proposeFilename('/repo/finra-droppn.wd', 'qwen:3b', ask), 'finra-dropping.wd');
  assert.equal(await proposeFilename('/repo/finra-droppn.wd', 'qwen:3b', async () => ({response: '{"filename":"../escape.wd"}'})), null);
  assert.equal(await proposeFilename('/repo/finra-droppn.wd', 'qwen:3b', async () => ({response: 'bad json'})), null);
});

test('requires selection and confirmation before using WorkspaceEdit rename', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-filename-'));
  const source = path.join(root, 'finra-droppn.wd');
  await fs.writeFile(source, 'Existing file content.');
  const fileUri = fsPath => ({scheme:'file',fsPath});
  const repo = {rootUri:fileUri(root),state:{workingTreeChanges:[{uri:fileUri(source)}]}};
  const renamed = [];
  let confirmed = false;
  const vscode = {
    Uri:{file:fileUri}, FileType:{File:1, SymbolicLink:64}, ProgressLocation:{Notification:1},
    workspace:{fs:{async stat(uri) {
      try { const stat = await fs.lstat(uri.fsPath); return {type:stat.isSymbolicLink()?64:stat.isFile()?1:2}; }
      catch (error) { throw error; }
    }}, async applyEdit(edit) {
      assert.equal(confirmed,true);
      for (const e of edit.operations) {await fs.rename(e.oldUri.fsPath,e.newUri.fsPath);renamed.push(e);}
      return true;
    }},
    WorkspaceEdit:class { constructor(){this.operations=[];} renameFile(oldUri,newUri,options){this.operations.push({oldUri,newUri,options});} },
    window:{
      async withProgress(_settings,fn){return fn(null,{isCancellationRequested:false});},
      async showQuickPick(options){assert.match(options[0].label,/finra-droppn.*finra-dropping/);return options;},
      async showWarningMessage(message,_options,button){assert.match(message,/Rename 1 file/);confirmed=true;return button;},
      showErrorMessage(msg){throw new Error(msg);},
      showInformationMessage(){},
    }
  };
  try {
    const result = await spellcheckFilenames(vscode,null,{repositories:[repo],model:'qwen:3b',suggest:async()=> 'finra-dropping.wd'});
    assert.equal(result.length,1);
    assert.equal(renamed.length,1);
    assert.equal(await fs.readFile(path.join(root,'finra-dropping.wd'),'utf8'),'Existing file content.');
    assert.equal(await fs.stat(source).then(()=>true,()=>false),false);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('cancelled review does not rename a selected file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'sweetiebot-filename-cancel-'));
  const source = path.join(root,'bad-speling.md');
  await fs.writeFile(source,'Notes');
  const uri = fsPath => ({scheme:'file', fsPath});
  const vscode = {
    FileType:{File:1,SymbolicLink:64},Uri:{file:uri}, ProgressLocation:{Notification:1},
    workspace:{fs:{stat:async u=>({type:(await fs.stat(u.fsPath)).isFile()?1:2})},
      applyEdit:async()=>{throw new Error('Should not rename');}},
    window:{withProgress:async(_s,fn)=>fn(null,null),showQuickPick:async()=>undefined,
      showInformationMessage:()=>{},showErrorMessage:()=>{},showWarningMessage:()=>{throw new Error('Unexpected confirmation');}}
  };
  try {
    assert.deepEqual(await spellcheckFilenames(vscode,null,{repositories:[{rootUri:uri(root),state:{workingTreeChanges:[{uri:uri(source)}]}}],
      model:'qwen:3b',suggest:async()=> 'bad-spelling.md'}),[]);
    assert.equal(await fs.readFile(source,'utf8'),'Notes');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
