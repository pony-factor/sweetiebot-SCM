// Theme-aware wing for the native Codex Send button. No React-owned nodes are replaced.
(() => {
 'use strict';
 if (globalThis.scmToolkitCodexSendWing) return;
 globalThis.scmToolkitCodexSendWing = true;
 const CLASS = 'scm-toolkit-pegasus-send';
 const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">'
 + '<path d="M2.5 21c3.4-2.1 4.7-5.6 6.4-9.2C12 5.6 16.7 3.5 22 3c-.9 3.8-3.4 6.8-7.2 8.7 2.8-.5 5.2-1.6 6.7-3.1-1.1 4.1-4.4 7.5-9.6 8.6-3.1.7-6.2 1.7-9.4 3.8Z"/>'
 + '<path d="M5.7 18.2c3.7-4 8.3-9.1 14.8-12.9M10.3 13.9l.7 3.3M13.9 10.4l1 4.1M17.6 7.4l1.1 3.4"/></svg>';
 const mask='url("data:image/svg+xml,'+encodeURIComponent(svg)+'")';
 const style=document.createElement('style');
 style.textContent=[
 ':root[data-codex-window-type="extension"] button.bg-composer-primary.'+CLASS+' { position: relative !important; }',
 ':root[data-codex-window-type="extension"] button.bg-composer-primary.'+CLASS+' svg { opacity: 0 !important; }',
 ':root[data-codex-window-type="extension"] button.bg-composer-primary.'+CLASS+'::after { content:""; position:absolute; inset:0; margin:auto; width:22px; height:22px; pointer-events:none; background-color:var(--vscode-button-foreground, #ffffff); -webkit-mask:'+mask+' center / contain no-repeat; mask:'+mask+' center / contain no-repeat; }'
 ].join('\n');
 document.head.append(style);
 function isSend(button) {
  if (!button || !button.matches('button.bg-composer-primary')
   || !button.closest('[data-composer-body], [class*="ComposerLayout"], [class*="Composer_"]')) return false;
  const name=[button.getAttribute('aria-label'),button.getAttribute('title'),
   button.getAttribute('data-testid'),button.textContent].filter(Boolean).join(' ');
  if (/\b(stop|cancel|interrupt|queue|pause|voice|dictat|microphone|retry|settings?)\b/i.test(name)) return false;
  return /\b(send|submit)\b/i.test(name)||(!name&&button.type==='submit');
 }
 function scan() {
  const enabled=document.documentElement.getAttribute('data-codex-window-type')==='extension';
  document.querySelectorAll('button.bg-composer-primary, button.'+CLASS).forEach(button=>{
   const on=enabled&&isSend(button);
   if (button.classList.contains(CLASS)!==on) button.classList.toggle(CLASS,on);
  });
 }
 if (globalThis.__SCM_TOOLKIT_SEND_WING_TEST__) {
  Object.assign(globalThis.__SCM_TOOLKIT_SEND_WING_TEST__,{isSend,scan,svg,mask}); return;
 }
 let scheduled=false;
 function schedule() {
  if(scheduled)return;
  scheduled=true;
  requestAnimationFrame(()=>{scheduled=false;scan();});
 }
 scan();
 new MutationObserver(schedule).observe(document.documentElement,{
  childList:true,subtree:true,characterData:true,attributes:true,
  attributeFilter:['aria-label','title','data-testid','type','data-codex-window-type']
 });
})();