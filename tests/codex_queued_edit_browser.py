"""Browser checks for inline queued editing against a native-shaped queue adapter."""
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets/codex'

FIXTURE = r'''
window.queue = [{id:'a',text:'First queued prompt',context:{files:['fixture.txt']}}, {id:'b',text:'Second queued prompt',context:{images:['fixture.png']}}];
window.held = 0; window.sent = []; window.nativePreviews = 0; window.automatic = false; window.detachedRails = 0;
window.dispatchQueued = () => { if(automatic && !held && queue.length){sent.push(queue.shift()); renderQueue();} };
const actions = {
 get:id=>queue.find(m=>m.id===id),
 async beginEdit(id){
  const index=queue.findIndex(m=>m.id===id); if(index<0)return null;
  const receipt={index,message:queue[index],serverSubmission:{serializedText:queue[index].text},previousMessageId:queue[index-1]?.id??null,nextMessageId:queue[index+1]?.id??null};
  queue.splice(index,1); renderQueue(); return receipt;
 },
 async restoreEdit(receipt){
  if(window.failRestore)throw Error('native storage failure');
  const next=queue.findIndex(m=>m.id===receipt.nextMessageId);queue.splice(next<0?receipt.index:next,0,{...receipt.message,text:receipt.serverSubmission?.serializedText??receipt.message.text});renderQueue();
 }
 ,async send(message,options){
  if(window.failRestore)throw Error('native storage failure');
  const next=queue.findIndex(m=>m.id===options.editPosition.nextMessageId);
  queue.splice(next<0?queue.length:next,0,message);renderQueue();return {status:'queued',messageId:message.id};
 }
};
const coordinator=()=>({deferAutomaticTurns(){held++;return {[Symbol.dispose](){held--;dispatchQueued();}};}});
window.renderQueue = () => {
 let list=document.getElementById('list');
 if(!queue.length){const rail=list?.parentElement;setTimeout(()=>{if(!queue.length){rail?.remove();detachedRails++;}},0);}
 else {
  if(!list){const rail=document.createElement('div');rail.id='rail';rail.innerHTML='<div id="list"></div>';document.getElementById('composer').prepend(rail);list=rail.firstChild;}
  for(const row of list.querySelectorAll('[data-scm-toolkit-queue-id]'))if(!queue.some(m=>m.id===row.dataset.scmToolkitQueueId))row.remove();
  for(const m of queue){
   let row=list.querySelector(`[data-scm-toolkit-queue-id="${m.id}"]`);
   if(!row){row=document.createElement('div');const preview=document.createElement('div');preview.setAttribute('data-scm-toolkit-queue-preview','');preview.tabIndex=0;preview.textContent=m.text;preview.addEventListener('click',()=>nativePreviews++);row.append(preview);scmToolkitQueueRowRef(()=>{},m.id,'local')(row);list.append(row);}
  }
 }
 scmToolkitRegisterQueueStore('thread','local',{messages:queue,actions},coordinator);
};
renderQueue();
'''


def run():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CODEX_TEST_CHROMIUM') or None, headless=True)
        page = browser.new_page(viewport={'width': 360, 'height': 800})
        page.route('https://queue-edit.test/**', lambda route: route.fulfill(body='<html><head></head><body><section id="composer" data-composer-surface-variant="default"><div id="rail"><div id="list"></div></div><div data-composer-body><textarea id="main">Main draft stays here</textarea></div></section><button id="outside">Outside</button></body></html>', content_type='text/html'))
        page.goto('https://queue-edit.test/')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_script_tag(content=(ASSETS / 'queued-edit-bridge.js').read_text())
        page.add_script_tag(content=(ASSETS / 'queued-edit.js').read_text())
        page.add_script_tag(content=FIXTURE)
        page.locator('[data-scm-toolkit-queue-id="b"] [data-scm-toolkit-queue-preview]').click()
        field = page.get_by_role('textbox', name='Queued message text', exact=True)
        field.wait_for(state='visible')
        page.wait_for_function('document.querySelector(".scm-toolkit-queue-editor textarea")?.disabled===false')
        assert field.input_value() == 'Second queued prompt'
        assert page.evaluate('held') == 1
        assert page.evaluate('nativePreviews') == 0
        assert page.locator('#main').input_value() == 'Main draft stays here'
        long_text = '\n'.join('Expanded queued line ' + str(i) for i in range(14))
        field.fill(long_text)
        assert field.bounding_box()['height'] > 200
        field.press('Enter')
        assert page.evaluate('sent.length') == 0, 'ordinary Enter only edits the queued prompt'
        field.fill('Second queued prompt, edited')
        page.evaluate('automatic=true;dispatchQueued()')
        assert page.evaluate('sent.length') == 0, 'completion waits while editing'
        page.get_by_role('button', name='Save', exact=True).click()
        page.wait_for_function('held===0 && sent.length===1')
        assert page.evaluate('sent[0].id') == 'a'
        assert page.evaluate('queue[0].id') == 'b'
        assert page.evaluate('queue[0].text') == 'Second queued prompt, edited'
        assert page.evaluate('queue[0].context.images[0]') == 'fixture.png'
        page.evaluate('automatic=false')
        page.locator('[data-scm-toolkit-queue-id="b"] [data-scm-toolkit-queue-preview]').click()
        page.wait_for_function('held===1')
        # Removing the last native row must not remove the active inline editor.
        field.wait_for(state='visible')
        page.wait_for_function('detachedRails>0')
        page.wait_for_function('document.activeElement === document.querySelector(".scm-toolkit-queue-editor textarea")')
        field.fill('Do not keep this edit')
        field.press('Escape')
        page.wait_for_function('held===0 && queue.length===1')
        assert page.evaluate('queue[0].text') == 'Second queued prompt, edited'
        page.locator('[data-scm-toolkit-queue-id="b"] [data-scm-toolkit-queue-preview]').click()
        page.wait_for_function('held===1')
        field.fill('Saved when focus leaves')
        page.locator('#outside').click()
        page.wait_for_function('held===0 && queue[0]?.text==="Saved when focus leaves"')
        # Persistence failures keep the editor and hold alive; retry commits once.
        page.locator('[data-scm-toolkit-queue-id="b"] [data-scm-toolkit-queue-preview]').click()
        page.wait_for_function('held===1')
        field.fill('Retry safely')
        page.evaluate('failRestore=true')
        page.get_by_role('button', name='Save', exact=True).click()
        page.get_by_role('status').filter(has_text='Could not save').wait_for()
        assert page.evaluate('held') == 1
        assert field.input_value() == 'Retry safely'
        page.evaluate('failRestore=false')
        page.get_by_role('button', name='Save', exact=True).click()
        page.wait_for_function('held===0 && queue[0]?.text==="Retry safely"')
        assert page.locator('#main').input_value() == 'Main draft stays here'
        assert not errors, errors
        browser.close()
        print('PASS: inline expansion, pause, FIFO, attachments, native preview interception, cancel, blur-save, last-row survival, and retry')


if __name__ == '__main__':
    run()
