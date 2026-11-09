'use strict';
const assert=require('node:assert/strict');
const {openRepairRunner,arrangeRunnerPanes,updateResponsiveRunnerLayout,createRepairPool,createExecutionQueue}=require('../../extension/merge/runner-layout');
(async()=>{
  const batch={label:'Squash merge PRs'},dashboard={label:'Lindsey · Merge progress'},draft={label:'Original PR',draft:'unsent text'};
  const groups=[{viewColumn:1,tabs:[batch]},{viewColumn:2,tabs:[dashboard,draft]}];
  let active=0,selected=0,setting=true,opens=0;const layouts=[];
  const names=['First','Second','Third','Fourth','Fifth'];
  const vscode={window:{tabGroups:{all:groups}},ConfigurationTarget:{Workspace:2},
    workspace:{getConfiguration:()=>({inspect:()=>({workspaceValue:setting}),update:async(_key,value)=>{setting=value;}})},
    commands:{executeCommand:async(command,args)=>{
      if(command==='workbench.action.browser.open'){
        opens++;groups[active].tabs.push({label:'Resolve PR conflicts',url:args.url});selected=groups[active].tabs.length-1;return;
      }
      if(command==='vscode.setEditorLayout'){
        layouts.push(args);const count=args.groups.reduce((sum,group)=>sum+(group.groups?.length||1),0);
        while(groups.length<count)groups.push({viewColumn:groups.length+1,tabs:[]});return;
      }
      if(command==='workbench.action.keepEditor')return;
      const focus=names.findIndex(name=>command==='workbench.action.focus'+name+'EditorGroup');
      if(focus>=0){active=focus;selected=0;return;}
      const index=/workbench\.action\.openEditorAtIndex(\d+)/.exec(command);
      if(index){selected=Number(index[1])-1;return;}
      if(command==='moveActiveEditor'){
        assert.equal(setting,false,'Moving tabs temporarily preserves empty destinations');
        const tab=groups[active].tabs.splice(selected,1)[0];assert(tab);
        active=args.value-1;groups[active].tabs.push(tab);selected=groups[active].tabs.length-1;return;
      }
      throw Error('Unexpected command '+command);
    }}
  };
  const url='https://chatgpt.com/#sweetiebot_merge=1&q=fix';
  await openRepairRunner(vscode,url,{repository:'o/r',number:494});
  assert.equal(opens,1);
  assert.deepEqual(groups[0].tabs,[batch]);
  assert(groups[1].tabs.some(tab=>{const opened=new URL(tab.url);assert(opened.searchParams.get('sweetiebot_launch'));opened.searchParams.delete('sweetiebot_launch');return opened.href===url;}),'Second runner is stacked below the original batch');
  assert(groups[2].tabs.includes(dashboard)&&groups[2].tabs.includes(draft));
  assert.equal(draft.draft,'unsent text');assert.equal(setting,true,'Original editor setting is restored');
  assert.equal(groups.length,5,'Four corner panes surround the center dashboard');
  await arrangeRunnerPanes(vscode);
  assert.equal(groups[active].tabs[selected],dashboard,'The center report stays visible');
  const beforeResize=layouts.length;
  assert.equal(await updateResponsiveRunnerLayout(vscode,600),true,'A narrow report receives a wider center column');
  assert.deepEqual(layouts.at(-1).groups.map(group=>group.size),[0.2,0.6,0.2]);
  for(const width of [600,720,900,700])assert.equal(await updateResponsiveRunnerLayout(vscode,width),false);
  assert.equal(layouts.length,beforeResize+1,'Resizing does not oscillate or remount tabs');
  assert.equal(await updateResponsiveRunnerLayout(vscode,1000),true);
  assert.equal(layouts.at(-1).groups[1].size,0.44);
  assert.equal(draft.draft,'unsent text','Resizing preserves the existing draft');
  await Promise.all([openRepairRunner(vscode,url+'2',{repository:'o/r',number:492}),openRepairRunner(vscode,url+'3',{repository:'o/r',number:496})]);
  assert(groups[0].tabs.includes(batch));
  for(const column of [1,2,4,5])assert.equal(groups[column-1].tabs.length,1,'Each corner shows one of four chats');
  assert(groups[2].tabs.includes(dashboard)&&groups[2].tabs.includes(draft));
  await openRepairRunner(vscode,url,{repository:'o/r',number:494});
  assert.equal(opens,3,'Repeated action focuses its existing repair chat');
  await openRepairRunner(vscode,url+'4',{repository:'o/r',number:497});
  assert.equal(groups[0].tabs.length,2,'Additional chats share corner panes as tabs');
  assert.equal(groups[2].tabs.length,2,'Extra chats never cover the center report');
  assert(layouts.every(layout=>layout.groups[0].groups.length===2&&layout.groups[2].groups.length===2));
  groups.splice(0,groups.length,{viewColumn:1,tabs:[dashboard,draft]});active=0;selected=0;
  await openRepairRunner(vscode,url+'single',{repository:'o/r',number:500});
  assert.equal(groups.length,5,'A dashboard-only window retains the four-corner layout');
  assert.equal(groups[0].tabs.length,1);
  assert(groups[2].tabs.includes(dashboard)&&groups[2].tabs.includes(draft));
  const pool=createRepairPool(),started=[],finishers=[];
  const tasks=Array.from({length:5},(_,index)=>pool.run('repair-'+index,async slot=>{
    started.push({index,slot});let finish;
    const done=new Promise(resolve=>{finish=resolve;});finishers[index]=finish;
    return {done,dispose:finish};
  }));
  await Promise.all(tasks.slice(0,3));
  assert.deepEqual(started.map(item=>item.slot),[4,5,6],'Three repair chats use slots four through six');
  assert.equal(started.length,3,'Additional repairs wait without opening another chat');
  assert.equal(pool.run('repair-0',()=>assert.fail('Duplicate repair')),tasks[0]);
  finishers[0]();await tasks[3];
  assert.equal(started[3].slot,4,'Completion frees a slot for the next queued repair');
  finishers[1]();await tasks[4];
  pool.dispose();await Promise.all(tasks.map(async task=>(await task).done));
  const serial=createExecutionQueue(),order=[];let releaseWrite;
  const writeGate=new Promise(resolve=>{releaseWrite=resolve;});
  const first=serial(async()=>{order.push('first');await writeGate;order.push('first done');});
  const second=serial(async()=>{order.push('second');});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,['first'],'Review and repair writes share a serialized queue');
  releaseWrite();await Promise.all([first,second]);
  assert.deepEqual(order,['first','first done','second']);
  await assert.rejects(serial(async()=>{throw Error('Failed write');}),/Failed write/);
  await serial(async()=>order.push('recovered'));
  assert.equal(order.at(-1),'recovered','A failed write does not strand later queued work');
  console.log('In-window repair chats, stacked runner panes, overflow tabs, duplicate focus and draft preservation passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
