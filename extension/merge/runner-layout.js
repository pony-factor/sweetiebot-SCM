'use strict';
const windows = new WeakMap();
const names = ['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth'];

// Reviews have three reserved chats. Repairs use three additional slots;
// waiting jobs do not open another chat, and a PR cannot occupy two slots.
function createRepairPool() {
  const jobs = new Map(), pending = [], active = new Map();
  let disposed = false;
  function drain() {
    while (!disposed && pending.length && active.size < 3) {
      const job = pending.shift();
      const slot = [4,5,6].find(id => !active.has(id));
      active.set(slot, job);
      const release = () => {
        if (active.get(slot) !== job) return;
        active.delete(slot); jobs.delete(job.key); drain();
      };
      Promise.resolve().then(() => {
        if (disposed) throw Error('The bulk repair queue was closed.');
        return job.start(slot);
      }).then(handle => {
        if (disposed) {handle?.dispose?.();job.reject(Error('The bulk repair queue was closed.'));release();return;}
        job.handle = handle;
        job.resolve(handle);
        Promise.resolve(handle?.done).catch(() => {}).finally(release);
      }, error => { job.reject(error); release(); });
    }
  }
  return {
    run(key, start) {
      if (disposed) return Promise.reject(Error('The bulk repair queue was closed.'));
      if (jobs.has(key)) return jobs.get(key).promise;
      let resolve, reject;
      const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
      const job = {key,start,promise,resolve,reject};
      jobs.set(key,job);pending.push(job);drain();
      return promise;
    },
    dispose() {
      disposed=true;
      for (const job of pending.splice(0)) {jobs.delete(job.key);job.reject(Error('The bulk repair queue was closed.'));}
      for (const job of active.values()) job.handle?.dispose?.();
    }
  };
}

function createExecutionQueue() {
  let tail = Promise.resolve();
  return task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
}
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
function runnerLayout(compact) {
  const center=compact?0.6:0.44;
  const side=(1-center)/2;
  return {orientation:0,groups:[
    {size:side,groups:[{size:0.5},{size:0.5}]},
    {size:center},
    {size:side,groups:[{size:0.5},{size:0.5}]}
  ]};
}
// Keep the report in the center and preserve all four corner groups. Width
// changes only adjust the center share, with hysteresis to avoid oscillation.
async function updateResponsiveRunnerLayout(vscode,dashboardWidth) {
  if (!Number.isInteger(dashboardWidth) || dashboardWidth<160 || dashboardWidth>20000) return false;
  const current=state(vscode);
  const groups=vscode.window.tabGroups?.all || [];
  if (!groups.some(group=>group.tabs.some(tab=>tab.label==='Lindsey · Merge progress'))) return false;
  const compact=current.compact ? dashboardWidth<=920 : dashboardWidth<640;
  if (compact===current.compact) return false;
  current.compact=compact;
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout',runnerLayout(compact));
  } catch (error) {
    current.compact=!compact;
    throw error;
  }
  return true;
}
async function arrangeRunnerPanes(vscode) {
  const current=state(vscode);
  const dashboard = (vscode.window.tabGroups?.all || []).flatMap(group=>group.tabs)
    .find(tab=>tab.label==='Lindsey · Merge progress');
  if (!dashboard) return;
  // A window reload retains its editors but loses the in-memory runner map.
  for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
    if (/ChatGPT|Squash.*merge|Prepare merge handoff|Resolve PR conflicts|Lindsey · Local merge/i.test(tab.label || '') &&
        ![...current.runners.values()].includes(tab)) current.runners.set(tab,tab);
  }
  const runners=[...current.runners.values()];
  const dashboardColumn = 3;
  const cornerColumns = [1,2,4,5];
  const others = vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>!runners.includes(tab) && tab!==dashboard);
  const config = vscode.workspace.getConfiguration('workbench.editor');
  const previous = config.inspect('closeEmptyGroups')?.workspaceValue;
  // Keep empty destination groups stable while moving existing tabs. Restore
  // the user's setting after every move; no tab is closed or reloaded.
  await config.update('closeEmptyGroups',false,vscode.ConfigurationTarget.Workspace);
  try {
    await vscode.commands.executeCommand('vscode.setEditorLayout',runnerLayout(state(vscode).compact));
    for (let index=0;index<runners.length;index++) await moveTab(vscode,runners[index],cornerColumns[index%cornerColumns.length]);
    for (const tab of others) await moveTab(vscode,tab,dashboardColumn);
    await moveTab(vscode,dashboard,dashboardColumn);
    await focusTab(vscode,dashboard);
    await vscode.commands.executeCommand('workbench.action.keepEditor');
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
    const close = await require('../github/pr-workflows').openWorkflow(vscode,url);
    registerMergeRunner(vscode,id,close.tab);
    await arrangeRunnerPanes(vscode);
    if (close.tab) await focusTab(vscode,close.tab);
    return true;
  });
  current.tail=next.catch(()=>{});
  return next;
}
function openInlineRepairRunner(vscode,url,id) {
  const current=state(vscode);
  const next=current.tail.then(async()=>{
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    const close=await require('../github/pr-workflows').openWorkflow(vscode,url);
    registerMergeRunner(vscode,id,close.tab);
    await arrangeRunnerPanes(vscode);
    return close;
  });
  current.tail=next.catch(()=>{});
  return next;
}
module.exports={registerMergeRunner,arrangeRunnerPanes,updateResponsiveRunnerLayout,openRepairRunner,openInlineRepairRunner,createRepairPool,createExecutionQueue};
