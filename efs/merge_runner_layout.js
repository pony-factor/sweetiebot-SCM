'use strict';
const windows = new WeakMap();
const names = ['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth'];
function state(vscode) {
  let current = windows.get(vscode.window);
  if (!current) { current = {runners:new Map(),tail:Promise.resolve()}; windows.set(vscode.window,current); }
  const live = new Set((vscode.window.tabGroups?.all || []).flatMap(group=>group.tabs));
  for (const [id,tab] of current.runners) if (!live.has(tab)) current.runners.delete(id);
  return current;
}
function registerMergeRunner(vscode,id,tab) { if (tab) state(vscode).runners.set(id,tab); }
async function focusTab(vscode,tab) {
  const groups = vscode.window.tabGroups?.all || [];
  const group = groups.find(group=>group.tabs.includes(tab));
  if (!group) return false;
  const column = group.viewColumn || groups.indexOf(group)+1;
  const index = group.tabs.indexOf(tab);
  if (!names[column-1]) throw Error('This runner cannot be focused in the current editor layout.');
  await vscode.commands.executeCommand('workbench.action.focus'+names[column-1]+'EditorGroup');
  await vscode.commands.executeCommand('workbench.action.openEditorAtIndex'+(index<9?index+1:1));
  if (index>=9) for (let step=0;step<index;step++) await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
  return true;
}
async function moveTab(vscode,tab,column) {
  const group = vscode.window.tabGroups.all.find(group=>group.tabs.includes(tab));
  if (!group || group.viewColumn===column) return;
  await focusTab(vscode,tab);
  await vscode.commands.executeCommand('moveActiveEditor',{to:'position',by:'group',value:column});
}
async function arrangeRunnerPanes(vscode) {
  const runners = [...state(vscode).runners.values()];
  const dashboard = (vscode.window.tabGroups?.all || []).flatMap(group=>group.tabs)
    .find(tab=>tab.label==='Lindsey · Merge progress');
  if (!runners.length || !dashboard) return;
  const stacked = runners.length>1;
  const dashboardColumn = stacked?3:2;
  const others = vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>!runners.includes(tab) && tab!==dashboard);
  const config = vscode.workspace.getConfiguration('workbench.editor');
  const previous = config.inspect('closeEmptyGroups')?.workspaceValue;
  // Keep empty destination groups stable while moving existing tabs. Restore
  // the user's setting after every move; no tab is closed or reloaded.
  await config.update('closeEmptyGroups',false,vscode.ConfigurationTarget.Workspace);
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout',{orientation:0,
      groups:[stacked?{size:0.2,groups:[{size:0.5},{size:0.5}]}:{size:0.2},{size:0.8}]});
    for (let index=0;index<runners.length;index++) await moveTab(vscode,runners[index],index%2+1);
    for (const tab of others) await moveTab(vscode,tab,dashboardColumn);
    await moveTab(vscode,dashboard,dashboardColumn);
  } finally { await config.update('closeEmptyGroups',previous,vscode.ConfigurationTarget.Workspace); }
}
function openRepairRunner(vscode,url,{repository,number}) {
  const current = state(vscode);
  const next = current.tail.then(async()=>{
    const id = 'repair:'+repository+'#'+number;
    const existing = state(vscode).runners.get(id);
    if (existing && await focusTab(vscode,existing)) return true;
    // On a restored batch, preserve its existing browser tabs as runners too.
    for (const group of vscode.window.tabGroups?.all || []) for (const tab of group.tabs) {
      if (/ChatGPT|Squash.*merge|Prepare merge handoff|Resolve PR conflicts/i.test(tab.label || '') &&
          ![...current.runners.values()].includes(tab)) current.runners.set(tab,tab);
    }
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    const close = await require('./pr_workflows').openWorkflow(vscode,url);
    registerMergeRunner(vscode,id,close.tab);
    await arrangeRunnerPanes(vscode);
    if (close.tab) await focusTab(vscode,close.tab);
    return true;
  });
  current.tail=next.catch(()=>{});
  return next;
}
module.exports={registerMergeRunner,arrangeRunnerPanes,openRepairRunner};
