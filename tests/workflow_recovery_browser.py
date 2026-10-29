"""Render the controls users lost; exercise real DOM replacement and CSS."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='


def main():
    with sync_playwright() as engine:
        browser = engine.chromium.launch(headless=True, executable_path=os.environ.get('CODEX_TEST_CHROMIUM') or None)
        page = browser.new_page(viewport={'width': 380, 'height': 720})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        picker = (ROOT / 'assets/workbench/picker.js').read_text()
        attach = picker[picker.index('function scmToolkitAttachCommitSettings('):picker.index('async function scmToolkitPullCleanRepository(')]
        page.set_content('<div class="scm-view"><div id="rows"><div class="monaco-list-row" data-index="0"><div class="scm-editor" id="input" style="height:30px"></div></div><div class="monaco-list-row" data-index="1"><div class="button-container"><div class="monaco-button-dropdown" id="actions" style="display:flex;height:30px"><button>Commit</button></div></div></div></div></div>')
        page.add_style_tag(content=(ROOT / 'assets/workbench/picker.css').read_text())
        page.add_script_tag(content=attach)
        page.evaluate('''() => {
            window.opened=0;
            const button=document.createElement('button'); button.className='scm-toolkit-settings';
            button.setAttribute('aria-label','Open Sweetiebot SCM settings');
            button.innerHTML='<span class="scm-toolkit-settings-icon">🪄</span>';
            button.onclick=()=>opened++;
            scmToolkitAttachCommitSettings({element:document.getElementById('input'),layout(){},disposables:{add(){}}},button);
        }''')
        wand = page.get_by_role('button', name='Open Sweetiebot SCM settings')
        wand.click()
        assert page.evaluate('opened') == 1
        assert wand.inner_text() == '🪄'
        assert wand.bounding_box()['width'] >= 20
        # The old helper moved the wand into an invisible native action row.
        page.eval_on_selector('#actions', "el=>el.style.display='none'")
        page.wait_for_function("document.querySelector('.scm-toolkit-settings').parentElement.id==='input'")
        wand.click()
        assert page.evaluate('opened') == 2
        page.eval_on_selector('#actions', "el=>el.style.display='flex'")
        page.wait_for_function("document.querySelector('.scm-toolkit-settings').parentElement.id==='actions'")
        page.eval_on_selector('#actions', "el=>el.remove()")
        page.wait_for_function("document.querySelector('.scm-toolkit-settings').parentElement.id==='input'")

        page.goto('about:blank')
        page.set_viewport_size({'width': 1100, 'height': 720})
        page.set_content('<div class="scm-view"><div class="scm-editor" id="bar" style="width:960px"></div></div>')
        page.add_style_tag(content=(ROOT / 'assets/workbench/picker.css').read_text())
        page.add_style_tag(content='.scm-editor-container{height:26px}.scm-editor-container textarea{box-sizing:border-box;height:26px;resize:none;white-space:pre;overflow:hidden}')
        message_bar = (ROOT / 'assets/workbench/message_bar.js').read_text().split('const scmToolkitCreateControlsWithoutMessageBarLayout')[0]
        page.add_script_tag(content=message_bar)
        page.evaluate('''() => {
            const bar=document.getElementById('bar');
            const classes={push:'push',branch:'branch',sync:'sync-branch',delete:'delete-branch',autocomplete:'autocomplete',spellcheck:'spellcheck','post-spellcheck':'post-spellcheck',codex:'codex-coauthor','auto-publish':'auto-publish',home:'home','pull-request':'pull-request','pony-branch':'pony-branch'};
            for(const id of SCM_TOOLKIT_MESSAGE_BAR_IDS){
                const node=document.createElement(id.startsWith('separator')?'span':'button');
                node.className='scm-toolkit-'+(classes[id]||'divider');
                node.textContent=id==='branch'?'hyper-sonic':id.startsWith('separator')?'':'x';
                bar.append(node);
            }
            const editor=document.createElement('div');editor.className='scm-editor-container';
            editor.innerHTML='<textarea aria-label="Commit message">A normal commit message</textarea>';bar.append(editor);
            window.controls={width:()=>500};
            window.widget={element:bar,inputEditor:{layout(size){editor.firstChild.style.width=size.width+'px';}},
                getContentHeight:()=>26,getToolbarWidth:()=>0,disposables:{add(){}},
                layout(){this.inputEditor.layout({width:bar.clientWidth-controls.width(),height:this.getContentHeight()});}};
            scmToolkitApplyMessageBarLayout(widget,{messageBarLayout:undefined},controls);
        }''')
        for width in (960, 440, 320, 240, 960):
            page.eval_on_selector('#bar', '(el,width)=>el.style.width=width+"px"', width)
            page.wait_for_timeout(75)
            geometry=page.evaluate('''() => {
                const root=document.getElementById('bar'),editor=root.querySelector('textarea');
                const r=root.getBoundingClientRect(),e=editor.getBoundingClientRect();
                return {width:e.width,height:e.height,barHeight:r.height,reserved:controls.width(),
                    overflow:root.scrollWidth-root.clientWidth,contentHeight:widget.getContentHeight()};
            }''')
            assert geometry['width'] >= 128, (width, geometry)
            assert geometry['height'] <= 30, (width, geometry)
            assert geometry['overflow'] <= 2, (width, geometry)
            assert geometry['barHeight'] < 160, (width, geometry)
            assert geometry['contentHeight'] >= geometry['barHeight'] - 2, (width, geometry)
        page.goto('about:blank')
        page.set_content('''<button id="mode" aria-label="Switch mode, current mode: Work" aria-expanded="false">Work</button>
            <div id="mode-menu" role="menu" hidden><button role="menuitem" id="chat">ChatGPT</button></div>
            <button id="model" aria-label="Select ChatGPT model" aria-haspopup="menu" aria-controls="power-menu" aria-expanded="false">6 Sol 6 Medium</button>
            <div id="power-menu" role="menu" hidden><button role="menuitem" id="models">Select model</button>
              <div id="power" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"></div></div>
            <div id="models-menu" role="menu" hidden><button role="menuitemradio" id="six">6</button><button role="menuitemradio">GPT-5.6 Sol</button></div>
            <div><div id="prompt-textarea" contenteditable="true"></div></div>''')
        page.evaluate('''() => {
            window.selectedModel='6 Sol 6';window.power=1;
            const model=document.getElementById('model'),mode=document.getElementById('mode');
            const powers=['Instant','Medium','High'];
            const render=()=>{model.textContent=selectedModel+' '+powers[power];document.getElementById('power').setAttribute('aria-valuenow',power);};
            mode.onclick=()=>{document.getElementById('mode-menu').hidden=false;mode.setAttribute('aria-expanded','true');};
            document.getElementById('chat').onclick=()=>{mode.setAttribute('aria-label','Switch mode, current mode: ChatGPT');mode.textContent='ChatGPT';mode.setAttribute('aria-expanded','false');document.getElementById('mode-menu').hidden=true;};
            const open=()=>{document.getElementById('power-menu').hidden=false;model.setAttribute('aria-expanded','true');};
            model.onclick=open;model.onkeydown=e=>{if(e.key==='ArrowDown')open();};
            document.getElementById('models').onclick=()=>document.getElementById('models-menu').hidden=false;
            document.getElementById('six').onclick=()=>{selectedModel='6';render();document.getElementById('models-menu').hidden=true;};
            document.getElementById('power').onkeydown=e=>{if(e.key==='ArrowRight'){power=Math.min(2,power+1);render();}};
            document.getElementById('power-menu').onkeydown=e=>{if(e.key==='Escape'){document.getElementById('power-menu').hidden=true;model.setAttribute('aria-expanded','false');}};
        }''')
        page.add_script_tag(content=(ROOT / 'assets/browser/maximize_thinking.js').read_text())
        page.wait_for_function('sweetiebotEnsureMaximumThinking()', polling=100)
        assert page.evaluate('selectedModel') == '6'
        assert page.evaluate('power') == 2
        assert page.get_attribute('#mode','aria-label') == 'Switch mode, current mode: ChatGPT'
        page.set_viewport_size({'width':380,'height':720})

        page.goto('about:blank')
        page.set_content('<div id="activity">Working for 6m 20s</div><span id="clock">Working for 6m 20s</span><div data-conversation-role="user"><span id="user">Working for 9m</span></div>')
        page.evaluate('(image)=>{globalThis.scmToolkitActivityCannonEnabled=true;globalThis.scmToolkitActivityCannonImage=image}', PNG)
        page.add_script_tag(content=(ROOT / 'assets/codex/activity-cannon.js').read_text())
        page.add_script_tag(content=(ROOT / 'assets/codex/hide-chat-timestamps.js').read_text())
        assert page.get_attribute('#clock', 'data-scm-toolkit-activity-dots') == '•' * 6
        assert page.get_attribute('#user', 'data-scm-toolkit-activity-cannon') is None
        page.eval_on_selector('#clock', "el=>el.textContent='Worked for 6m 20s'")
        page.wait_for_function("document.getElementById('clock').dataset.scmToolkitActivityDots==='••••••'")
        assert page.inner_text('#clock') == 'Worked for 6m 20s'
        page.eval_on_selector('#clock', "el=>el.textContent='Working for 7m 1s'")
        page.wait_for_function("document.getElementById('clock').dataset.scmToolkitActivityDots==='•••••••'")
        assert page.eval_on_selector('#clock', 'el=>getComputedStyle(el).fontSize') == '0px'

        page.goto('about:blank')
        page.set_content('''<div data-conversation-role="user"><p id="user-copy">You've hit your usage limit. Try again at 10:26 PM.</p></div>
            <article><p data-message-author-role="assistant" id="warning">You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at 10:26 PM.</p></article>
            <div style="position:absolute;bottom:20px;left:10px;width:350px">
              <div contenteditable="true" role="textbox" style="height:80px;border:1px solid"></div>
              <div role="status" id="footer">Rate limited</div></div>''')
        limit = (ROOT / 'assets/codex/rate-limit-controls.js').read_text().replace('"__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__"', repr(PNG)).replace('"__SCM_TOOLKIT_RATE_LIMIT_STICKER_ENABLED__"','true')
        page.add_script_tag(content=limit)
        for _ in range(15):
            page.eval_on_selector('#warning', "el=>el.textContent=\"You've hit your usage limit. Try again at 10:26 PM.\"")
            page.wait_for_function("document.getElementById('warning').textContent==='Rate limited'")
        assert page.inner_text('#user-copy').startswith("You've hit")
        assert page.eval_on_selector('#warning', 'el=>getComputedStyle(el).fontSize') == '0px'
        page.wait_for_selector('[data-scm-toolkit-rate-limit-pony] img')
        assert page.eval_on_selector('[data-scm-toolkit-rate-limit-pony] img', 'el=>el.complete && el.naturalWidth>0')
        # Mount the opt-in control after an already-compacted notice.
        page.evaluate('window.messages=[]')
        page.add_script_tag(content=(ROOT / 'assets/codex/rate-limit-continuation.js').read_text())
        page.evaluate("scmToolkitInstallRateLimitContinuation({postMessage:m=>messages.push(m)},()=> 'test-thread')")
        page.get_by_role('button', name='Continue unanswered work at reset').click()
        assert page.get_by_role('button', name='Cancel continuation at reset').is_visible()
        assert page.evaluate('messages.length') == 0, 'Never send while still limited before reset'
        page.evaluate('''() => {
            const deadline=scmToolkitRateLimitResetAt("Try again at 10:26 PM.");
            Date.now=()=>deadline+2000;
            document.body.append(document.createElement('hr'));
        }''')
        page.wait_for_function('messages.length===1')
        assert page.evaluate('messages[0].threadId') == 'test-thread'
        page.wait_for_timeout(100)
        assert page.get_by_role('button', name='Continue unanswered work at reset').count() == 0, 'A completed reset cannot arm a duplicate continuation'
        page.eval_on_selector('#footer', 'el=>el.remove()')
        page.wait_for_timeout(100)
        assert page.get_by_role('button', name='Continue unanswered work at reset').count() == 0, 'Old transcript warnings are not an active limit'
        page.evaluate("document.body.append(document.createElement('hr'))")
        assert page.evaluate('messages.length') == 1
        assert not errors, errors
        browser.close()
        print('Rendered wand visibility, recycled toolbar, active cannon, limit rewrites, Twilight image and opt-in continuation passed.')


if __name__ == '__main__':
    main()
