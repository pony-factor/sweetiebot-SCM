const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../assets/codex/send-wing.js'),'utf8');
let buttons=[],css='';
const root={mode:'extension',getAttribute(k){return k==='data-codex-window-type'?this.mode:'';}};
const document={documentElement:root,head:{append(el){css=el.textContent;}},createElement(){return {textContent:''};},querySelectorAll(){return buttons;}};
const hooks={};
vm.runInNewContext(code,{document,encodeURIComponent,globalThis:{__SCM_TOOLKIT_SEND_WING_TEST__:hooks}});
function button(label,opts={}){
 const classes=new Set(['bg-composer-primary']),attrs={'aria-label':label,'title':opts.title||'','data-testid':opts.testid||''};
 return {type:opts.type||'button',textContent:'',
  getAttribute(k){return attrs[k]||null;},matches(){return classes.has('bg-composer-primary');},
  closest(){return opts.outside?null:{};},
  classList:{contains(x){return classes.has(x);},toggle(x,on){if(on)classes.add(x);else classes.delete(x);}},
  rename(x){attrs['aria-label']=x;}};
}
const send=button('Send message'),empty=button('Send',{type:'submit'}),stop=button('Stop response');
const queue=button('Queue message'),mixed=button('Stop and send'),voice=button('Voice message'),outside=button('Send message',{outside:true});
const submit=button('',{type:'submit'});empty.disabled=true;
assert.equal(hooks.isSend(send),true);
assert.equal(hooks.isSend(empty),true);
assert.equal(hooks.isSend(submit),true);
for(const b of [stop,queue,mixed,voice,outside])assert.equal(hooks.isSend(b),false);
buttons=[send,empty,stop,queue,mixed,voice,outside];hooks.scan();
assert.equal(send.classList.contains('scm-toolkit-pegasus-send'),true);
assert.equal(empty.classList.contains('scm-toolkit-pegasus-send'),true);
assert.equal(stop.classList.contains('scm-toolkit-pegasus-send'),false);
send.rename('Stop response');hooks.scan();
assert.equal(send.classList.contains('scm-toolkit-pegasus-send'),false);
root.mode='other';hooks.scan();
assert.equal(empty.classList.contains('scm-toolkit-pegasus-send'),false);
assert.match(css,/--vscode-button-foreground/);
assert.match(css,/-webkit-mask/);
assert.match(css,/::after/);
assert.match(hooks.svg,/stroke="white"/);
assert.match(hooks.svg,/<path/);
console.log('Codex pegasus wing checks passed.');
