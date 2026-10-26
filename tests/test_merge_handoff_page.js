'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require.resolve('../efs/merge/merge_handoff.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
async function page({raw, state, result, statusFailsDuringPost = false}) {
  const status = {}, results = {after(){}}, navigations = [], posts = [];
  let poll;
  const sandbox = {URL,URLSearchParams,JSON,Error,
    document:{getElementById:id=>id==='status'?status:results,createElement:()=>({})},
    location:{hash:raw===undefined?'':'#result='+encodeURIComponent(raw),pathname:'/lindsey-merge/nonce',assign:url=>navigations.push(url)},
    history:{replaceState(){}},setInterval:callback=>{poll=callback;return 1;},clearInterval(){},
    fetch:async (path,options)=> {
      if(options?.method==='POST') {
        posts.push(options.body);
        if (statusFailsDuringPost) {poll();await new Promise(resolve=>setImmediate(resolve));}
        return {ok:true,status:200,json:async()=>result};
      }
      assert.equal(path,'/lindsey-merge/nonce/status');
      if(statusFailsDuringPost) return {ok:false,status:404};
      return {ok:true,json:async()=>state};
    }
  };
  await vm.runInNewContext(script,sandbox);
  return {status:status.textContent,results:results.textContent,navigations,posts};
}
(async()=>{
  const result={results:[{number:1,status:'merged'}],continueUrl:'https://chatgpt.com/#sweetiebot_merge=1&q=next'};
  const fresh=await page({raw:JSON.stringify({version:1}),result});
  assert.equal(fresh.posts.length,1);
  assert.deepEqual(fresh.navigations,[result.continueUrl],'Continue immediately without a background-tab timer');
  const legacy=await page({raw:'{}',result,statusFailsDuringPost:true});
  assert.deepEqual(legacy.navigations,[result.continueUrl],'A missing status endpoint cannot discard a successful original apply response');
  assert.equal(legacy.posts.length,1,'Failed status polling never retries Git execution');
  const reload=await page({state:{phase:'finished',result}});
  assert.equal(reload.posts.length,0,'Reload never repeats local Git execution');
  assert.deepEqual(reload.navigations,[result.continueUrl],'Reload recovers a completed continuation');
  const running=await page({state:{phase:'running'}});
  assert(running.status.includes('still running'));
  assert.equal(running.posts.length,0);
  const malformed=await page({raw:'{"version":1,"patch":"unfinished'});
  assert(malformed.status.includes('No Git operation was started'));
  assert.equal(malformed.posts.length,0);
  const unsafe=await page({state:{phase:'finished',result:{...result,continueUrl:'https://evil.invalid/#sweetiebot_merge=1'}}});
  assert.equal(unsafe.navigations.length,0);
  assert(unsafe.status.includes('Invalid batch continuation'));
  console.log('Handoff page reload recovery, no duplicate execution, malformed input and continuation checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
