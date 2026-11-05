'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createMergeHandoff } = require('../extension/merge/handoff');
const root = path.join(__dirname, '..');
const helpers = vm.createContext({ Date });
// The standalone helpers are tested without enabling automatic continuation.
vm.runInContext(fs.readFileSync(path.join(root, 'assets/codex/rate-limit-continuation.js'), 'utf8')
  .replace('__SCM_TOOLKIT_CONTINUE_AT_RESET_ENABLED__', 'false'), helpers);
vm.runInContext(fs.readFileSync(path.join(root, 'assets/codex/activity-cannon.js'), 'utf8'), helpers);
const now = new Date(2026, 9, 28, 20, 0).getTime();
assert.equal(helpers.scmToolkitRateLimitResetAt('Try again at 10:26 PM.', now), new Date(2026,9,28,22,26).getTime());
assert.equal(helpers.scmToolkitRateLimitResetAt('Try again in 2 minutes', now), now + 120000);
assert.equal(helpers.scmToolkitRateLimitResetAt('Try again later', now), null);
assert.equal(helpers.scmToolkitActivityMinutes('Working for 6m 20s'), 6);
assert.equal(helpers.scmToolkitActivityMinutes('Working for 59s'), 0);
assert.equal(helpers.scmToolkitActivityMinutes('Worked for 1h 2m'), 62);
assert.equal(helpers.scmToolkitActivityMinutes('Ordinary user text 6m'), null);
(async () => {
  const bridge = await createMergeHandoff({ repository: 'owner/repo', pullRequests: [{number:1,title:'Test',head:'topic',base:'main',headSha:'a'.repeat(40),url:'https://github.com/owner/repo/pull/1'}] });
  try {
    const prompt = 'Complete selected review. 🪄\n'.repeat(1800);
    bridge.setPrompt(prompt);
    const address = 'https://chatgpt.com/#' + new URLSearchParams({sweetiebot_merge:'1',return_to:bridge.url});
    assert(address.length < 250);
    assert.equal((await (await fetch(bridge.url + '/prompt')).json()).prompt, prompt);
    let promptHandler, transportHandler, collectorHandler, navigate;
    const frame={url:'https://chatgpt.com/'};
    const contents={mainFrame:frame, ipc:{handle(channel, handler){
      if (channel === 'sweetiebot:merge-prompt') promptHandler = handler;
      else if (channel === 'sweetiebot:merge-transport') transportHandler = handler;
      else if (channel === 'sweetiebot:merge-collector') collectorHandler = handler;
      else assert.fail('Unexpected native channel: ' + channel);
    }},
      getBackgroundThrottling:()=>true,setBackgroundThrottling(){},on(_event,listener){navigate=listener;}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'assets/browser/pr-background.js'),'utf8'),
      {URL,URLSearchParams,fetch,AbortSignal,Uint8Array,TextDecoder,_view:{webContents:contents}});
    assert.equal(typeof transportHandler, 'function', 'Sandboxed gzip transport is registered alongside the prompt transport');
    await assert.rejects(transportHandler({senderFrame:frame},{action:'validate',data:'abc'}),/Invalid merge transport sender/);
    await assert.rejects(promptHandler({senderFrame:frame}),/Invalid merge prompt sender/);
    navigate({},address,false,true);
    assert.equal(JSON.parse(await promptHandler({senderFrame:frame})).prompt,prompt);
    const conversation = 'https://chatgpt.com/g/g-p-example/c/merge-chat';
    navigate({}, conversation, false, true);
    frame.url = conversation;
    assert.equal(await collectorHandler({senderFrame:frame}), bridge.url,
      'A conversation reload recovers the original callback without a prompt');
    navigate({}, conversation, false, true);
    assert.equal(await collectorHandler({senderFrame:frame}), bridge.url);
    await assert.rejects(collectorHandler({senderFrame:{url:conversation}}), /Invalid merge collector sender/);
    navigate({}, 'https://chatgpt.com/c/unrelated-chat', false, true);
    frame.url = 'https://chatgpt.com/c/unrelated-chat';
    await assert.rejects(collectorHandler({senderFrame:frame}), /Invalid merge collector sender/,
      'Another chat cannot inherit merge authorization');
    frame.url = 'https://chatgpt.com/';
    navigate({},address,false,true);
    await assert.rejects(promptHandler({senderFrame:{url:frame.url}}),/Invalid merge prompt sender/);
    frame.url='https://evil.invalid/';
    await assert.rejects(promptHandler({senderFrame:frame}),/Invalid merge prompt sender/);
    frame.url='https://chatgpt.com/';
    navigate({},'https://evil.invalid/',false,true);
    await assert.rejects(promptHandler({senderFrame:frame}),/Invalid merge prompt sender/);

    assert.equal((await fetch(bridge.url + '/prompt',{headers:{Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await (await fetch(bridge.url+'/status')).json()).phase,'ready','Reading a prompt never executes a merge');
    assert.throws(()=>bridge.setPrompt('x'.repeat(100001)),/transport budget/);
    const loader = fs.readFileSync(path.join(root,'assets/browser/pull-request-submit.js'),'utf8').split('// Keep prompt bodies out of navigation URLs and browser-generated metadata.')[1];
    let received;
    const window = {location:new URL(address)};window.top=window;
    const errors=[];
    vm.runInNewContext(loader,{window,URL,URLSearchParams,TextEncoder,AbortSignal,
      require(name){
        assert.equal(name,'electron','Sandbox uses only its supported Electron API');
        return {ipcRenderer:{async invoke(channel){
          assert.equal(channel,'sweetiebot:merge-prompt');
          return await (await fetch(bridge.url+'/prompt')).text();
        }}};
      },
      console:{error:(...args)=>errors.push(args)},
      history:{state:{},replaceState(_state,_title,url){window.location=new URL(url);}},
      scmToolkitStartPullRequestWorkflow(url){received=new URLSearchParams(new URL(url).hash.slice(1)).get('q');}});
    const deadline=Date.now()+5000;
    while(received===undefined && !errors.length && Date.now()<deadline) await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(errors,[]);
    assert.equal(received,prompt);
    assert.equal(window.location.href,'https://chatgpt.com/','The real page URL never receives the prompt');
    const recovery = fs.readFileSync(path.join(root,'assets/browser/pull-request-submit.js'),'utf8')
      .split('// Resume the existing collector after a reload or full conversation navigation.')[1]
      .split('// Keep prompt bodies out of navigation URLs and browser-generated metadata.')[0];
    const restoredWindow = {location:new URL(conversation)}; restoredWindow.top=restoredWindow;
    let resumed;
    vm.runInNewContext(recovery, {window:restoredWindow,URL,URLSearchParams,
      require(){return {ipcRenderer:{async invoke(channel){
        assert.equal(channel,'sweetiebot:merge-collector'); return bridge.url;
      }}};},
      scmToolkitStartPullRequestWorkflow(url){resumed=new URL(url);}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(resumed.pathname,new URL(conversation).pathname);
    const resumedArgs = new URLSearchParams(resumed.hash.slice(1));
    assert.equal(resumedArgs.get('sweetiebot_collect'),'1');
    assert.equal(resumedArgs.get('return_to'),bridge.url);
    assert.equal(resumedArgs.has('q'),false,'Recovery never resubmits the merge prompt');
    assert.equal(restoredWindow.location.href,conversation,'Recovery keeps transport out of the visible URL');
  } finally {bridge.dispose();}
  console.log('Short prompt transport, authorization boundaries, reset parsing and active cannon regressions passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
