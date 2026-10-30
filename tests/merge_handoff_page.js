'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require.resolve('../extension/merge/handoff.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
async function page({raw, state, result, statusFailsDuringPost = false}) {
  const element = tag => ({ tag, children: [], textContent: '', className: '',
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    after(...nodes) { this.afterNodes = nodes; } });
  const status = element('p'), results = element('div'), summary = element('div');
  const navigations = [], posts = [];
  let poll;
  const sandbox = {URL,URLSearchParams,JSON,Error,
    document:{getElementById:id=>({status,results,summary})[id],createElement:element},
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
  return {status:status.textContent,summary:summary.textContent,cards:results.children,navigations,posts};
}
(async()=>{
  const result={results:[{number:1,status:'merged'}],continueUrl:'https://chatgpt.com/#sweetiebot_merge=1&q=next'};
  const fresh=await page({raw:JSON.stringify({version:1}),result});
  assert.equal(fresh.posts.length,1);
  assert.equal(fresh.summary,'1 PR processed');
  assert.equal(fresh.cards[0].children[0].children[0].textContent,'#1');
  assert.equal(fresh.cards[0].children[0].children[1].className,'flag merged');
  const blocked = await page({state:{phase:'finished',result:{results:[{number:544,status:'blocked',
    reason:'Selected PR changed',url:'javascript:alert(1)'}],batch:{merged:[],deferred:[544]}}}});
  assert.equal(blocked.summary,'0 merged · 1 need attention');
  assert.equal(blocked.cards[0].children[1].textContent,'Selected PR changed');
  assert.equal(blocked.cards[0].children.length,2,'Unsafe URLs never become links');
  assert.equal(blocked.cards[1].className,'batch-summary');
  const linked = await page({state:{phase:'finished',result:{results:[{number:3,status:'merged',
    url:'https://github.com/pony-factor/sweetiebot-SCM/pull/3'}]}}});
  assert.equal(linked.cards[0].children[1].href,'https://github.com/pony-factor/sweetiebot-SCM/pull/3');
  assert.equal(linked.cards[0].children[1].rel,'noopener noreferrer');
  const stylesheet = fs.readFileSync(require.resolve('../extension/merge/header.css'),'utf8');
  const pageMarkup = fs.readFileSync(require.resolve('../extension/merge/handoff.html'),'utf8');
  assert(pageMarkup.includes('__MERGE_HEADER_CSS__'));
  assert(pageMarkup.includes('class="merge-header"'));
  assert(stylesheet.includes('.merge-header .dashboard-brand'));
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
