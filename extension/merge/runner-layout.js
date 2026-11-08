'use strict';
const windows = new WeakMap();
const names = ['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth'];
function state(vscode) {
  let current = windows.get(vscode.window);
  if (!current) { current = {runners:new Map(),tail:Promise.resolve(),compact:false}; windows.set(vscode.window,current); }
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
function runnerLayout(compact,stacked) {
  const left=compact?0.5:0.2;
  return {orientation:0,groups:[
    stacked?{size:left,groups:[{size:0.5},{size:0.5}]}:{size:left},
    {size:1-left}
  ]};
}
// Restored windows can have the dashboard in either left-hand group. Returning
// to 20/80 must leave it wider than the compact-entry threshold on that side.
async function updateResponsiveRunnerLayout(vscode,dashboardWidth) {
  if (!Number.isInteger(dashboardWidth) || dashboardWidth<160 || dashboardWidth>20000) return false;
  const current=state(vscode);
  const groups=vscode.window.tabGroups?.all || [];
  const dashboardGroup=groups.find(group=>group.tabs.some(tab=>tab.label==='Lindsey · Merge progress'));
  if (!dashboardGroup || !groups.some(group=>group!==dashboardGroup && group.tabs.length)) return false;
  const dashboardOnLeft=groups.indexOf(dashboardGroup)<groups.length-1;
  const expandedShare=dashboardOnLeft?0.2:0.8;
  const restoreWidth=Math.max(690,860*0.5/expandedShare);
  const compact=current.compact ? dashboardWidth<=restoreWidth : dashboardWidth<820;
  if (compact===current.compact) return false;
  current.compact=compact;
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout',runnerLayout(compact,groups.length>2));
  } catch (error) {
    current.compact=!compact;
    throw error;
  }
  return true;
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
    await vscode.commands.executeCommand('vscode.setEditorLayout',runnerLayout(state(vscode).compact,stacked));
    for (let index=0;index<runners.length;index++) await moveTab(vscode,runners[index],index%2+1);
    for (const tab of others) await moveTab(vscode,tab,dashboardColumn);
    await moveTab(vscode,dashboard,dashboardColumn);
  } finally { await config.update('closeEmptyGroups',previous,vscode.ConfigurationTarget.Workspace); }
}
function openRepairRunner(vscode,url,{repository,number,reuse=true}) {
  const current = state(vscode);
  const next = current.tail.then(async()=>{
    const id = 'repair:'+repository+'#'+number;
    const existing = state(vscode).runners.get(id);
    if (reuse && existing && await focusTab(vscode,existing)) return true;
    // On a restored batch, preserve its existing browser tabs as runners too.
    for (const group of vscode.window.tabGroups?.all || []) for (const tab of group.tabs) {
      if (/ChatGPT|Squash.*merge|Prepare merge handoff|Resolve PR conflicts/i.test(tab.label || '') &&
          ![...current.runners.values()].includes(tab)) current.runners.set(tab,tab);
    }
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    const close = await require('../github/pr-workflows').openWorkflow(vscode,url);
    registerMergeRunner(vscode,id,close.tab);
    await arrangeRunnerPanes(vscode);
    if (close.tab) await focusTab(vscode,close.tab);
    return true;
  });
  current.tail=next.catch(()=>{});
  return next;
}
module.exports={registerMergeRunner,arrangeRunnerPanes,updateResponsiveRunnerLayout,openRepairRunner};
