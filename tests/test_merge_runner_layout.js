'use strict';
const assert=require('node:assert/strict');
const {openRepairRunner}=require('../extension/merge/merge_runner_layout');
(async()=>{
  const batch={label:'Squash merge PRs'},dashboard={label:'Lindsey · Merge progress'},draft={label:'Original PR',draft:'unsent text'};
  const groups=[{viewColumn:1,tabs:[batch]},{viewColumn:2,tabs:[dashboard,draft]}];
  let active=0,selected=0,setting=true,opens=0;const layouts=[];
  const names=['First','Second','Third'];
  const vscode={window:{tabGroups:{all:groups}},ConfigurationTarget:{Workspace:2},
    workspace:{getConfiguration:()=>({inspect:()=>({workspaceValue:setting}),update:async(_key,value)=>{setting=value;}})},
    commands:{executeCommand:async(command,args)=>{
      if(command==='workbench.action.browser.open'){
        opens++;groups[active].tabs.push({label:'Resolve PR conflicts',url:args.url});selected=groups[active].tabs.length-1;return;
      }
      if(command==='vscode.setEditorLayout'){
        layouts.push(args);const count=args.groups[0].groups?3:2;
        while(groups.length<count)groups.push({viewColumn:groups.length+1,tabs:[]});return;
      }
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
  assert(groups[1].tabs.some(tab=>tab.url===url),'Second runner is stacked below the original batch');
  assert(groups[2].tabs.includes(dashboard)&&groups[2].tabs.includes(draft));
  assert.equal(draft.draft,'unsent text');assert.equal(setting,true,'Original editor setting is restored');
  await Promise.all([openRepairRunner(vscode,url+'2',{repository:'o/r',number:492}),openRepairRunner(vscode,url+'3',{repository:'o/r',number:496})]);
  assert.equal(groups[0].tabs.length,2,'Third runner becomes an upper-left tab');
  assert.equal(groups[1].tabs.length,2,'Fourth runner becomes a lower-left tab');
  assert.equal(groups[2].tabs.length,2,'Dashboard and unrelated editor remain on the right');
  await openRepairRunner(vscode,url,{repository:'o/r',number:494});
  assert.equal(opens,3,'Repeated action focuses its existing repair chat');
  assert(layouts.every(layout=>layout.groups[0].groups.length===2));
  groups.splice(0,groups.length,{viewColumn:1,tabs:[dashboard,draft]});active=0;selected=0;
  await openRepairRunner(vscode,url+'single',{repository:'o/r',number:500});
  assert.equal(groups.length,2,'A dashboard-only window gains one runner pane on the left');
  assert.equal(groups[0].tabs.length,1);
  assert(groups[1].tabs.includes(dashboard)&&groups[1].tabs.includes(draft));
  console.log('In-window repair chats, stacked runner panes, overflow tabs, duplicate focus and draft preservation passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
