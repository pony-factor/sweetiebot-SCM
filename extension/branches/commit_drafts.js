'use strict';
const {createHash}=require('node:crypto');
const path=require('node:path');
const states=new WeakMap();
const key=root=>'sweetiebot.commitDraft.v1.'+createHash('sha256').update(path.resolve(root)).digest('hex');

async function registerCommitDrafts(vscode,context) {
  const state={storage:context.globalState};
  states.set(vscode,state);
  state.ready=(async()=>{
    const extension=vscode.extensions.getExtension('vscode.git');
    if(!extension||!state.storage)return;
    const git=await extension.activate();state.api=git.getAPI(1);
    const restore=async repository=>{
      const root=repository.rootUri?.fsPath;
      if(!root||!repository.inputBox)return;
      const saved=state.storage.get(key(root));
      if(typeof saved?.value!=='string'||!saved.value)return;
      // Native Git drafts and text already typed in the destination win.
      if(!repository.inputBox.value)repository.inputBox.value=saved.value;
      if(repository.inputBox.value===saved.value)await state.storage.update(key(root),undefined);
    };
    const listener=state.api.onDidOpenRepository?.(repository=>{
      void restore(repository).catch(error=>vscode.window.showWarningMessage('Could not restore the saved commit message: '+error.message));
    });
    if(listener)context.subscriptions.push(listener);
    for(const repository of state.api.repositories||[])await restore(repository);
  })();
  await state.ready;
}

async function preserveCommitDraft(vscode,source,destination,capturedValue) {
  const state=states.get(vscode);if(!state)return;
  await state.ready;if(!state.api||!state.storage)return;
  const repository=(state.api.repositories||[]).find(repository=>
    path.resolve(repository.rootUri.fsPath)===path.resolve(source));
  const value=typeof capturedValue==='string'?capturedValue:repository?.inputBox?.value;
  if(typeof value!=='string')return;
  await state.storage.update(key(source),value?{value}:undefined);
  if(!destination||!value||path.resolve(destination)===path.resolve(source))return;
  const target=state.storage.get(key(destination));
  if(typeof target?.value==='string'&&target.value)return;
  const open=(state.api.repositories||[]).find(repository=>
    path.resolve(repository.rootUri.fsPath)===path.resolve(destination));
  if(open?.inputBox?.value)return;
  await state.storage.update(key(destination),{value});
}

module.exports={registerCommitDrafts,preserveCommitDraft};
