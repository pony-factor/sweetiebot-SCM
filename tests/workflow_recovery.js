'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createMergeHandoff } = require('../extension/merge/handoff');
const root = path.join(__dirname, '..');
const helpers = vm.createContext({ Date });
vm.runInContext(fs.readFileSync(path.join(root, 'assets/codex/rate-limit-continuation.js'), 'utf8'), helpers);
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
    assert.equal((await fetch(bridge.url + '/prompt',{headers:{Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await (await fetch(bridge.url+'/status')).json()).phase,'ready','Reading a prompt never executes a merge');
    assert.throws(()=>bridge.setPrompt('x'.repeat(100001)),/transport budget/);
    const loader = fs.readFileSync(path.join(root,'assets/browser/pull_request_submit.js'),'utf8').split('// Keep prompt bodies out of navigation URLs and browser-generated metadata.')[1];
    let received;
    const window = {location:new URL(address)};window.top=window;
    const errors=[];
    vm.runInNewContext(loader,{window,URL,URLSearchParams,Buffer,require,
      console:{error:(...args)=>errors.push(args)},
      history:{state:{},replaceState(_state,_title,url){window.location=new URL(url);}},
      scmToolkitStartPullRequestWorkflow(url){received=new URLSearchParams(new URL(url).hash.slice(1)).get('q');}});
    const deadline=Date.now()+5000;
    while(received===undefined && !errors.length && Date.now()<deadline) await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(errors,[]);
    assert.equal(received,prompt);
    assert.equal(window.location.href,'https://chatgpt.com/','The real page URL never receives the prompt');
  } finally {bridge.dispose();}
  console.log('Short prompt transport, authorization boundaries, reset parsing and active cannon regressions passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
