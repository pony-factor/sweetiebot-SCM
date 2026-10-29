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
        page.set_content('<div id="activity">Working for 6m 20s</div><span id="clock">Working for 6m 20s</span><div data-conversation-role="user"><span id="user">Working for 9m</span></div>')
        page.evaluate('(image)=>{globalThis.scmToolkitActivityCannonEnabled=true;globalThis.scmToolkitActivityCannonImage=image}', PNG)
        page.add_script_tag(content=(ROOT / 'assets/codex/activity-cannon.js').read_text())
        assert page.get_attribute('#clock', 'data-scm-toolkit-activity-dots') == '•' * 6
        assert page.get_attribute('#user', 'data-scm-toolkit-activity-cannon') is None
        page.eval_on_selector('#clock', "el=>el.textContent='Working for 7m 1s'")
        page.wait_for_function("document.getElementById('clock').dataset.scmToolkitActivityDots==='•••••••'")
        assert page.eval_on_selector('#clock', 'el=>getComputedStyle(el).fontSize') == '0px'

        page.goto('about:blank')
        page.set_content('''<div data-conversation-role="user"><p id="user-copy">You've hit your usage limit. Try again at 10:26 PM.</p></div>
            <article><p id="warning">You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at 10:26 PM.</p></article>
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
        page.evaluate("document.body.append(document.createElement('hr'))")
        assert page.evaluate('messages.length') == 1
        assert not errors, errors
        browser.close()
        print('Rendered wand visibility, recycled toolbar, active cannon, limit rewrites, Twilight image and opt-in continuation passed.')


if __name__ == '__main__':
    main()
