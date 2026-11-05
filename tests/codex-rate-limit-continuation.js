'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/codex/rate-limit-continuation.js'), 'utf8');
function setup(noticeText = 'Rate limited · resets in 1 second') {
  const messages=[], microtasks=[], timers=[], listeners={};
  const state={now:1000,queued:false,composerText:'',threadId:'chat-one'};
  const notice={textContent:noticeText,dataset:{},closest:()=>null};
  let created=false;
  const context=vm.createContext({
    document:{
      documentElement:{},
      querySelectorAll(s){return s.startsWith('p, span,')?[notice]:[];},
      querySelector(s){
        if(s.startsWith('[data-testid="queued-message"]'))return state.queued?{}:null;
        if(s.includes('textarea'))return{get textContent(){return state.composerText;},value:''};
        return null;
      },
      createElement(){created=true;throw Error('No composer button allowed');}
    },
    window:{addEventListener(n,f){listeners[n]=f;}},
    MutationObserver:class{observe(){}},
    queueMicrotask(f){microtasks.push(f);},
    clearTimeout(t){if(t)t.canceled=true;},
    setTimeout(f,delay){const t={f,delay,canceled:false};timers.push(t);return t;},
    Date:class extends Date{static now(){return state.now;}}
  });
  vm.runInContext(source,context);
  context.scmToolkitInstallRateLimitContinuation({postMessage(m){messages.push(m);}},()=>state.threadId);
  return {state,messages,listeners,get created(){return created;},
    setting(enabled){listeners.message({data:{type:'scm-toolkit-resume-setting',enabled}});},
    flush(){while(microtasks.length)microtasks.shift()();},
    advance(now){state.now=now;for(const t of timers.filter(x=>!x.canceled)){t.canceled=true;t.f();}}
  };
}
const off=setup();off.flush();
assert.equal(off.messages[0].type,'scm-toolkit-read-resume-setting');
off.advance(3000);assert.equal(off.messages.length,1);
const on=setup();on.setting(true);on.flush();
assert.equal(on.messages.length,1,'Cannot continue early');on.advance(3000);
assert.deepEqual(JSON.parse(JSON.stringify(on.messages.slice(1))),
 [{type:'scm-toolkit-continue-at-reset',threadId:'chat-one',resetAt:2000}]);
assert.equal(on.created,false,'No separate composer button');
on.listeners.hashchange();on.flush();assert.equal(on.messages.length,2,'Only one continuation');
const draft=setup();draft.setting(true);draft.state.composerText='draft';draft.flush();draft.advance(3000);
assert.equal(draft.messages.length,1,'Never interrupt drafts');
const queued=setup();queued.setting(true);queued.state.queued=true;queued.flush();queued.advance(3000);
assert.equal(queued.messages.length,1,'Never override queued prompts');
const unknown=setup('Rate limited');unknown.setting(true);unknown.flush();
assert.equal(unknown.messages[1].type,'scm-toolkit-read-limit-reset');
unknown.advance(30000);assert.equal(unknown.messages.some(x=>x.type==='scm-toolkit-continue-at-reset'),false);
const switched=setup();switched.setting(true);switched.flush();switched.setting(false);switched.flush();switched.advance(3000);
assert.equal(switched.messages.some(x=>x.type==='scm-toolkit-continue-at-reset'),false,'Live off disables continuation');
console.log('Draggable Codex continuation checkbox safety checks passed.');
