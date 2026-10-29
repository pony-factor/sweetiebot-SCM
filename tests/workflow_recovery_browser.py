"""Render the controls users lost; exercise real DOM replacement and CSS."""
from pathlib import Path
import base64
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
        # Render the actual Lindsey page, including the host-provided helpers.
        dashboard=(ROOT / 'extension/merge/dashboard.html').read_text()
        for marker, filename in {
            '__MARKDOWN_RENDERER__':'dashboard_markdown.js','__DIFF_RENDERER__':'dashboard_diff.js',
            '__COMMIT_TREE__':'commit_tree.js','__ACTIVITY_RENDERER__':'dashboard_activity.js',
            '__TIMESTAMP_FORMATTER__':'dashboard_timestamps.js',
        }.items():
            dashboard=dashboard.replace(marker,(ROOT / 'extension/merge' / filename).read_text())
        dashboard=dashboard.replace('__NONCE__','fixture').replace('__CSP_SOURCE__','https://fixture.invalid')
        dashboard=dashboard.replace('__RATE_LIMIT_FORMATTER__','function rateLimitMessage(){return "Rate limited";}')
        page.evaluate('window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage(){}})')
        page.route('https://**/*',lambda route:route.abort())
        page.set_content(dashboard)
        page.evaluate('''() => {
            const now=Date.now();
            const pr=number=>({number,title:'Feature '+number,head:'topic-'+number,base:'main',state:'waiting',
                files:[],commits:[],events:[],blockerOptions:[],manualActions:[],reviewComments:[]});
            const first=pr(1),second=pr(2);
            first.activity={phase:'integrating',location:'local',message:'Integrating in the isolated checkout',
                at:new Date(now-125000).toISOString(),updatedAt:new Date(now-4000).toISOString()};
            second.activity={phase:'waiting-checks',location:'upstream',message:'Waiting for integrated-head checks',
                at:new Date(now-65000).toISOString(),updatedAt:new Date(now-2000).toISOString(),nextPollAt:now+15000,
                checks:[{name:'Regression tests',result:'in_progress'}]};
            window.dashboardState={type:'state',repository:'fixture/repo',prs:[first,second],showPrCommits:false,
                events:[{id:1,number:1,state:'progress',location:'local',message:'Creating isolated checkout',details:'Existing worktree preserved',at:new Date(now).toISOString()},
                    {id:2,number:2,state:'progress',location:'upstream',message:'Pushing branch update to GitHub',at:new Date(now).toISOString()}]};
            window.postMessage(dashboardState,'*');
        }''')
        page.wait_for_selector('.activity-elapsed')
        assert page.locator('#current-activity .activity-origin.local').count() == 1
        assert page.locator('#current-activity .activity-origin.upstream').count() == 1
        assert page.locator('#events .activity-origin.local').count() == 1
        assert page.locator('#events .activity-origin.upstream').count() == 1
        assert 'Regression tests · in_progress' in page.inner_text('.activity-checks')
        assert 'next GitHub check in' in page.inner_text('#current-activity')
        clock=page.locator('.activity-elapsed').first.inner_text()
        page.locator('#events summary').first.click()
        page.evaluate("window.openActivity=document.querySelector('#events details')")
        page.wait_for_function("() => document.querySelector('.activity-elapsed').textContent!=="+repr(clock))
        assert page.evaluate("openActivity===document.querySelector('#events details') && openActivity.open"), 'Clock ticks cannot rebuild or close timeline entries'
        for width in (1100, 440, 320):
            page.set_viewport_size({'width':width,'height':900})
            page.wait_for_timeout(50)
            geometry=page.evaluate('''() => {
                const bar=document.getElementById('merge-progress'),r=bar.getBoundingClientRect();
                return {below:r.top>=document.querySelector('header').getBoundingClientRect().bottom,
                    left:r.left,right:r.right,radius:parseFloat(getComputedStyle(bar).borderRadius),
                    active:bar.dataset.active};
            }''')
            assert geometry['below'] and geometry['left'] >= 0 and geometry['right'] <= width, geometry
            assert geometry['radius'] > 0 and geometry['active'] == 'true'
        page.evaluate("dashboardState.error='GitHub request failed';window.postMessage(dashboardState,'*')")
        page.wait_for_function("() => document.getElementById('merge-progress').dataset.active==='false'")
        assert page.locator('.activity-elapsed').count() == 0, 'Failed work cannot keep claiming active elapsed progress'
        assert not errors, errors
        page.unroute('https://**/*')
        page.goto('about:blank')
        page.set_viewport_size({'width':380,'height':720})
        picker = (ROOT / 'assets/workbench/picker.js').read_text()
        attach = picker[picker.index('function scmToolkitAttachCommitSettings('):picker.index('async function scmToolkitPullCleanRepository(')]
        page.set_content('<div class="scm-view" id="scm" style="width:350px"><div id="rows"><div class="monaco-list-row" data-index="0"><div class="scm-editor" id="input" style="height:30px"></div></div><div class="monaco-list-row" data-index="1"><div class="button-container"><div class="monaco-button-dropdown" id="actions" style="display:flex;height:30px"><button class="monaco-button">Commit</button><button class="monaco-button monaco-dropdown-button" aria-label="Commit options">⌄</button></div></div></div></div></div>')
        page.add_style_tag(content=(ROOT / 'assets/workbench/picker.css').read_text())
        page.add_style_tag(content=':root{--vscode-button-border:rgb(32,156,210);--vscode-foreground:white;--vscode-cornerRadius-small:5px}.monaco-button-dropdown{box-sizing:border-box;width:100%}.monaco-button{min-width:0;flex:1 1 auto;border:1px solid red}.monaco-dropdown-button{flex:0 0 24px}')
        page.add_style_tag(content=(ROOT / 'assets/workbench/outlined_buttons.css').read_text())
        page.add_script_tag(content=attach)
        page.evaluate('''() => {
            window.opened=0;
            const button=document.createElement('button'); button.className='scm-toolkit-settings';
            button.setAttribute('aria-label','Open Sweetiebot SCM settings');
            button.innerHTML='<span class="scm-toolkit-settings-icon">🪄</span>';
            button.onclick=()=>opened++;
            window.commits=0;window.menus=0;
            document.querySelector('#actions > .monaco-button').onclick=()=>commits++;
            document.querySelector('#actions > .monaco-dropdown-button').onclick=()=>menus++;
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
        for disabled in (False, True, False):
            page.eval_on_selector('#actions', '''(el,disabled)=>{
                el.classList.toggle('disabled',disabled);
                for(const button of el.querySelectorAll('.monaco-button')){button.disabled=disabled;button.classList.toggle('disabled',disabled);}
                el.querySelector('.monaco-button').textContent=disabled?'Dash':'Commit';
            }''', disabled)
            for width in (350, 240, 180):
                page.eval_on_selector('#scm','(el,width)=>el.style.width=width+"px"',width)
                page.wait_for_function("document.querySelector('.scm-toolkit-settings').parentElement.id==='actions'")
                geometry=page.eval_on_selector('#actions', '''el=>{
                    const wand=el.querySelector('.scm-toolkit-settings'),arrow=el.querySelector('.monaco-dropdown-button');
                    const r=el.getBoundingClientRect(),w=wand.getBoundingClientRect(),a=arrow.getBoundingClientRect();
                    return {last:el.lastElementChild===wand,after:w.left>=a.right-1,inside:w.right<=r.right-1,
                        height:w.height,overflow:el.scrollWidth-el.clientWidth,border:getComputedStyle(el).borderRightColor,
                        borderWidth:getComputedStyle(el).borderRightWidth,wandBorder:getComputedStyle(wand).borderRightWidth,
                        disabled:wand.disabled,radius:getComputedStyle(el).borderTopRightRadius};
                }''')
                assert geometry['last'] and geometry['after'] and geometry['inside'], (disabled,width,geometry)
                assert geometry['height'] >= 24 and geometry['overflow'] <= 1, (disabled,width,geometry)
                assert geometry['border'] == 'rgb(32, 156, 210)' and geometry['borderWidth'] == '1px'
                assert geometry['wandBorder'] == '0px' and geometry['radius'] == '5px', 'One custom outline surrounds commit, dropdown and wand'
                assert not geometry['disabled']
            before=page.evaluate('opened')
            wand.click()
            wand.press('Enter')
            assert page.evaluate('opened') == before+2, 'Settings stays usable when commit and dropdown are disabled'
            assert page.evaluate('commits===0 && menus===0'), 'Settings cannot commit or open the commit menu'
        page.eval_on_selector('#actions', '''el=>{
            const replacement=el.cloneNode(false);
            replacement.innerHTML='<button class="monaco-button" disabled>Dash</button><button class="monaco-button monaco-dropdown-button" disabled>⌄</button>';
            el.replaceWith(replacement);
        }''')
        page.wait_for_function("document.querySelector('#actions').lastElementChild?.classList.contains('scm-toolkit-settings')")
        assert wand.is_visible(), 'A recycled disabled action retains the same settings control'
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
            const classes={push:'push',branch:'branch',sync:'sync-branch',delete:'delete-branch',autocomplete:'autocomplete',spellcheck:'spellcheck','post-spellcheck':'post-spellcheck',codex:'codex-coauthor','auto-commit':'auto-commit','auto-publish':'auto-publish',home:'home','pull-request':'pull-request','pony-branch':'pony-branch'};
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
        # A long activity history must wrap without expanding a narrow chat or
        # rewriting the shared artwork when an attachment/progress node changes.
        page.goto('about:blank')
        page.set_content('''<div id="history" style="width:180px">
            <button id="disclosure" aria-label="Activity" aria-expanded="false" style="display:flex;max-width:100%;white-space:nowrap"><span id="long">Worked for 2h</span><span><svg id="activity-arrow" width="16" height="16"><path d="M1 1L8 8L1 15"/></svg></span></button>
            </div><div id="progress"></div><button aria-label="Other disclosure"><svg id="other-arrow" width="16" height="16"></svg></button>''')
        page.evaluate('''(image) => {
            globalThis.scmToolkitActivityCannonEnabled=true;globalThis.scmToolkitActivityCannonImage=image;
            for(let i=0;i<60;i++){const label=document.createElement('div');label.textContent='Worked for 30m';document.getElementById('history').append(label);}
            window.imageWrites=0;window.fullScans=0;window.opened=0;
            const set=CSSStyleDeclaration.prototype.setProperty;
            CSSStyleDeclaration.prototype.setProperty=function(name,...args){if(name==='--scm-toolkit-activity-cannon-image')imageWrites++;return set.call(this,name,...args);};
            const query=document.querySelectorAll.bind(document);
            document.querySelectorAll=function(selector){if(selector.includes('data-scm-toolkit-activity-cannon'))fullScans++;return query(selector);};
            document.getElementById('disclosure').onclick=()=>{opened++;document.getElementById('disclosure').setAttribute('aria-expanded',String(opened%2===1));};
        }''', PNG)
        page.add_script_tag(content=(ROOT / 'assets/codex/activity-cannon.js').read_text())
        for width in (180, 320, 100):
            page.eval_on_selector('#history', '(el,width)=>el.style.width=width+"px"', width)
            geometry=page.eval_on_selector('#history', '''el=>({overflow:el.scrollWidth-el.clientWidth,
                height:el.querySelector('#long').getBoundingClientRect().height,
                imageWidth:getComputedStyle(el.querySelector('#long'),'::after').width})''')
            assert geometry['overflow'] <= 1, (width, geometry)
            assert geometry['height'] > 24, (width, geometry)
            assert geometry['imageWidth'] == '22px'
        page.get_by_role('button', name='Activity', exact=True).click()
        assert page.evaluate('opened') == 1
        assert page.locator('#activity-arrow').is_hidden(), 'The expanded disclosure hides its separate arrow'
        page.get_by_role('button', name='Activity', exact=True).press('Enter')
        assert page.evaluate('opened') == 2
        assert page.locator('#activity-arrow').is_hidden(), 'The collapsed disclosure hides its separate arrow'
        assert page.locator('#other-arrow').is_visible(), 'Other disclosure icons remain native'
        page.eval_on_selector('#activity-arrow', 'el=>el.replaceWith(el.cloneNode(true))')
        assert page.locator('#activity-arrow').is_hidden(), 'React cannot bring the arrow back on rerender'
        assert page.evaluate('imageWrites') == 1, 'Artwork is shared once across the full history'
        before=page.evaluate('fullScans')
        page.evaluate('''() => {
            for(let i=0;i<30;i++){const img=document.createElement('img');img.alt='Upload progress '+i;document.getElementById('progress').append(img);}
            document.getElementById('long').textContent='Working for 3m';
        }''')
        page.wait_for_function("document.getElementById('long').dataset.scmToolkitActivityDots==='•••'")
        assert page.evaluate('imageWrites') == 1, 'Image/progress updates never rewrite the artwork'
        assert page.evaluate('fullScans') == before, 'Image/progress updates never rescan the transcript'
        page.add_script_tag(content=(ROOT / 'assets/codex/image-drop.js').read_text())
        image_bytes=base64.b64encode((ROOT / 'assets/imgs/activity-cannon.png').read_bytes()).decode()
        page.evaluate('''data => {
            window.dropDelivered=false;window.previewReady=false;
            scmToolkitRegisterImageDropTarget(document.getElementById('progress'),e=>e.preventDefault(),()=>{},e=>{
                e.preventDefault();window.dropDelivered=true;
                const file=e.dataTransfer.files[0],reader=new FileReader();
                reader.onload=()=>{const img=document.createElement('img');img.id='drop-preview';img.onload=()=>{window.previewReady=true;};img.src=reader.result;document.getElementById('progress').append(img);};
                reader.readAsDataURL(file);
            });
            const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),transfer=new DataTransfer();
            transfer.items.add(new File([bytes],'cannon-upload-validation.png',{type:'image/png'}));
            document.getElementById('progress').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
        }''', image_bytes)
        assert page.evaluate('dropDelivered'), 'The real File reaches the upload handler in the drop event'
        page.wait_for_function('previewReady')
        assert page.eval_on_selector('#drop-preview', 'el=>el.naturalWidth>0')
        assert page.evaluate('imageWrites') == 1
        assert page.evaluate('fullScans') == before
        page.eval_on_selector('#long', "el=>el.textContent='Unrelated action'")
        page.wait_for_function("!document.getElementById('disclosure').hasAttribute('data-scm-toolkit-activity-disclosure')")
        assert page.locator('#activity-arrow').is_visible(), 'A recycled non-activity control regains its own icon'

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
        page.eval_on_selector('#footer', "el=>{el.textContent='Rated limited';el.style.width='100%';el.style.height='200px'}")
        page.wait_for_selector('#footer img')
        assert page.eval_on_selector('#footer', 'el=>el.getBoundingClientRect().height<150 && el.getBoundingClientRect().width<200'), 'React cannot restore the oversized empty footer'
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
        # Unknown reset times use a bounded read-only native lookup only after opt-in.
        for still_limited in [True, False]:
            page.goto('about:blank')
            page.set_content('<div role="status">Rate limited</div><form><textarea></textarea></form>')
            page.evaluate('window.messages=[];window.testNow=Date.now();Date.now=()=>testNow')
            page.add_script_tag(content=(ROOT / 'assets/codex/rate-limit-continuation.js').read_text())
            page.evaluate("scmToolkitInstallRateLimitContinuation({postMessage:m=>messages.push(m)},()=> 'lookup-thread')")
            page.get_by_role('button', name='Continue unanswered work at reset').wait_for()
            assert page.evaluate('messages.length') == 0, 'Never poll quotas before opt-in'
            page.get_by_role('button', name='Continue unanswered work at reset').click()
            page.wait_for_function("messages.length===1 && messages[0].type==='scm-toolkit-read-limit-reset'")
            page.evaluate("""limited => window.postMessage({type:'scm-toolkit-limit-reset-result',
                threadId:'lookup-thread',requestId:messages[0].requestId,known:true,limited,resetAt:testNow+60000},'*')""", still_limited)
            if still_limited:
                page.get_by_role('button', name='Cancel continuation at reset').wait_for()
                page.evaluate("testNow+=62000;document.body.append(document.createElement('hr'))")
                page.wait_for_function("messages.some(m=>m.type==='scm-toolkit-continue-at-reset')")
                assert page.evaluate("messages.filter(m=>m.type==='scm-toolkit-continue-at-reset').length") == 1
            else:
                page.wait_for_function("!document.querySelector('[data-scm-toolkit-continue-at-reset]')")
                page.evaluate("testNow+=120000;document.body.append(document.createElement('hr'))")
                page.wait_for_timeout(100)
                assert page.evaluate('messages.length') == 1, 'An account that is no longer limited cannot auto-continue'
        assert not errors, errors
        browser.close()
        print('Rendered wand visibility, recycled toolbar, active cannon, limit rewrites, Twilight image and opt-in continuation passed.')


if __name__ == '__main__':
    main()
