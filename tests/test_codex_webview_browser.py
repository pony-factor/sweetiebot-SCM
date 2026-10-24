#!/usr/bin/env python3
"""Chromium host simulation for Codex webview patches.

Run: python tests/test_codex_webview_browser.py
Requires: pip install playwright; python -m playwright install chromium
Set CODEX_TEST_CHROMIUM to an existing executable to avoid downloading Chromium.
This runs real JS assets in a browser DOM, not the proprietary Codex extension.
"""

from pathlib import Path
import os
import shutil

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "codex"

HTML = """<!doctype html><html><head><style>
body {background:#101010;color:white;font:14px system-ui;margin:0}
header {padding:10px;background:#222}
#clock {display:inline-flex;background:#555;padding:4px}
.row {display:flex;gap:10px;margin:20px}
</style></head><body>
<header><div id="title"><span>CelestAI:</span><span> Codex</span><button id="new-chat">New Chat</button></div></header>
<div id="activity-row" class="row"><div id="clock"><span>9:</span><span>18 PM</span></div><span id="summary">Read files, ran commands</span></div>
<div class="row"><time id="single">9:19 PM</time><span>Another activity</span></div>
<div class="row"><span id="relative">Today at 6:44 PM</span><span>Something else</span></div>
<article data-message-id="m1"><p>Meet at <span id="prose">9:18 PM</span></p><span id="message">CelestAI: Codex, says the message</span><div class="markdown"><span id="markdown-time">9:18 PM</span></div><a id="link-time" href="#activity-row">9:18 PM</a></article>
<button id="activity" aria-expanded="false" aria-label="Worked for 1m 48s">Worked for 1m 48s</button>
<div id="ordinary">9:18 PM is not a separator</div>
</body></html>"""

def run():
    # Keep Python unittest discovery dependency-free; Playwright belongs only to
    # the dedicated browser integration job.
    from playwright.sync_api import sync_playwright

    custom_browser = os.environ.get("CODEX_TEST_CHROMIUM") or shutil.which("chromium") or shutil.which("chromium-browser")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=custom_browser or None, headless=True, args=["--no-sandbox"]
        )
        page = browser.new_page(viewport={"width": 740, "height": 600})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content(HTML)
        title = (ASSETS / "window-label.js").read_text().replace(
            "__SCM_TOOLKIT_CODEX_WINDOW_LABEL__", '"CelestAI"'
        )
        page.add_script_tag(content=title)
        timestamp = (ASSETS / "hide-chat-timestamps.js").read_text()
        page.add_script_tag(content=timestamp)

        def state(selector):
            return page.eval_on_selector(selector, """el => ({
                display:getComputedStyle(el).display,
                aria:el.getAttribute('aria-hidden'),
                marker:el.getAttribute('data-scm-toolkit-hidden-chat-timestamp'),
                text:el.textContent
            })""")

        for selector in ["#clock", "#single", "#relative"]:
            assert state(selector)["display"] == "none", (selector, state(selector))
        for selector in ["#summary", "#prose", "#message", "#markdown-time", "#link-time", "#ordinary"]:
            assert state(selector)["display"] != "none", (selector, state(selector))
        assert state("#title")["text"] == "CelestAINew Chat"
        assert state("#activity")["text"] == "Activity"
        assert state("#message")["text"] == "CelestAI: Codex, says the message"
        assert page.locator("#link-time").get_attribute("href") == "#activity-row"
        assert page.locator("#new-chat").is_enabled()

        # Regression: React can clear the hidden marker and apply inline !important.
        page.evaluate("""() => {
            const el=document.getElementById('clock');
            el.removeAttribute('data-scm-toolkit-hidden-chat-timestamp');
            el.setAttribute('aria-hidden','false');
            el.style.setProperty('display','inline-flex','important');
        }""")
        page.wait_for_timeout(50)
        assert state("#clock")["display"] == "none"
        assert state("#clock")["aria"] == "true"

        # Reconstruct the activity row as React might replace its DOM nodes.
        page.eval_on_selector("#activity-row", """row => {
            row.innerHTML = '<div id="clock"><span>9:</span><span>18 PM</span></div><span id="summary">Read files, ran commands</span>';
        }""")
        page.wait_for_timeout(50)
        assert state("#clock")["display"] == "none"

        # Seventy-five rewrites detect flicker regressions in real computed CSS.
        for index in range(75):
            page.evaluate("""index => {
                const el=document.getElementById('clock');
                el.removeAttribute('data-scm-toolkit-hidden-chat-timestamp');
                el.setAttribute('aria-hidden','false');
                el.style.setProperty('display','inline-block','important');
                if(index % 5 === 0) el.querySelectorAll('span')[1].firstChild.textContent = '18 PM';
            }""", index)
            page.wait_for_timeout(5)
            assert state("#clock")["display"] == "none", (index, state("#clock"))

        # Exercise actual paint frames: none may show the timestamp.
        visible_frames = page.evaluate("""async () => {
            let visible = 0;
            for (let i = 0; i < 60; i++) {
                const el = document.getElementById('clock');
                el.removeAttribute('data-scm-toolkit-hidden-chat-timestamp');
                el.style.setProperty('display', 'inline-flex', 'important');
                await new Promise(requestAnimationFrame);
                if (getComputedStyle(el).display !== 'none') visible++;
            }
            return visible;
        }""")
        assert visible_frames == 0, f"{visible_frames} painted frames exposed the timestamp"

        # The label must persist after the host rebuilds a header with controls.
        page.eval_on_selector("#title", """el => {
            el.innerHTML = '<span>CelestAI:</span><span> Codex</span><button>New Chat</button>';
        }""")
        page.wait_for_timeout(50)
        assert state("#title")["text"] == "CelestAINew Chat"
        # Browser-level regression: CSS must resolve to an accent even when the
        # Codex host does not expose the VS Code focus-border theme variable.
        page.add_script_tag(content=(ASSETS / "usage.js").read_text())
        page.evaluate("""() => {
            const pie = document.createElement('scm-toolkit-usage-pie');
            pie.id = 'codex-usage-pie';
            document.body.appendChild(pie);
            document.documentElement.style.removeProperty('--vscode-focusBorder');
        }""")

        def gradient(percent):
            return page.evaluate("""percent => {
                const pie = document.getElementById('codex-usage-pie');
                pie.setAttribute('percent', percent);
                return getComputedStyle(pie).backgroundImage;
            }""", percent)

        normal = gradient(11)
        assert '255, 185, 0' not in normal and 'rgb(255, 255, 255)' in normal, normal
        no_host_token = gradient(10)
        assert '255, 185, 0' in no_host_token, no_host_token
        assert '255, 185, 0' in gradient(1)
        page.evaluate("document.documentElement.style.setProperty('--vscode-focusBorder', '#12ab34')")
        configured_accent = gradient(10)
        assert '18, 171, 52' in configured_accent, configured_accent
        assert '255, 185, 0' not in configured_accent, configured_accent
        reset = gradient(50)
        assert '18, 171, 52' not in reset and 'rgb(255, 255, 255)' in reset, reset
        # Native footer container queries hide values below 300px even after
        # the controls wrap. Preserve the pie without expanding other labels.
        page.evaluate("""() => {
            document.body.insertAdjacentHTML('beforeend', `
                <style>
                  #compact-footer { container: composer-footer / inline-size; width:260px; }
                  #compact-controls { display:flex; flex-wrap:wrap; }
                  #model-row { flex-basis:100%; }
                  @container composer-footer (width <= 300px) {
                    [data-composer-footer-collapse=xs] { display:none; }
                  }
                </style>
                <div id="compact-footer"><div id="compact-controls">
                  <button id="model-row">Model</button>
                  <button data-composer-navigation-target="permissions">
                    <span id="permissions-label" data-composer-footer-collapse="xs">Full access</span>
                  </button>
                  <button data-composer-navigation-target="run-location">
                    <span data-composer-footer-collapse="xs"><span id="usage-value"></span></span>
                  </button>
                </div></div>`);
            document.getElementById('usage-value').append(document.getElementById('codex-usage-pie'));
        }""")
        for width in (260, 640, 280):
            page.eval_on_selector('#compact-footer', '(el, width) => el.style.width = width + "px"', width)
            assert page.locator('#codex-usage-pie').is_visible(), width
            assert page.locator('#permissions-label').is_visible() == (width > 300), width
            assert page.eval_on_selector('#compact-footer', 'el => el.scrollWidth <= el.clientWidth'), width
        assert page.locator('#codex-usage-pie').bounding_box()['width'] == 12
        # Promotion hiding removes the exhausted-messages upsell without hiding
        # the actual error or composer sharing its outer container.
        page.set_content("""<main>
            <p id="error">You've hit your usage limit. Try again later.</p>
            <section id="upsell"><span>You're out of Codex messages</span>
                <p>Your rate limit resets. To continue using Codex, add credits or upgrade to Pro today.</p>
                <div><button>Upgrade</button><button>Add Credits</button></div></section>
            <section id="fast"><span>Enable Fast mode</span><button>Enable now</button></section>
            <section id="ordinary-upgrade"><button>Upgrade</button></section>
            <textarea id="composer">continue</textarea></main>""")
        page.add_script_tag(content=(ASSETS / "hide-promotions.js").read_text())
        page.add_script_tag(content=(ASSETS / "hide-reset-times.js").read_text())
        assert page.locator('#upsell').is_visible()
        assert page.locator('#upsell [role="status"]').inner_text() == 'Rated Limited'
        assert not page.locator('#upsell button').first.is_visible()
        assert not page.locator('#upsell p').is_visible()
        assert not page.locator('#fast').is_visible()
        for selector in ['main', '#error', '#ordinary-upgrade', '#composer']:
            assert page.locator(selector).is_visible(), selector
        page.evaluate("""() => {
            document.querySelector('#upsell').remove();
            const card = document.createElement('section');
            card.id = 'replacement';
            card.innerHTML = '<span>You’re out of Codex messages</span><div><button>Upgrade</button><button>Add Credits</button></div>';
            document.querySelector('main').prepend(card);
        }""")
        page.wait_for_function("document.querySelector('#replacement [role=status]')?.textContent === 'Rated Limited'")
        assert page.locator('#replacement').is_visible()
        assert not page.locator('#replacement button').first.is_visible()
        page.eval_on_selector('#replacement', """card => {
            card.innerHTML = '<span>You’re out of Codex messages</span><p>Your rate limit resets at 2:00 AM.</p><div><button>Upgrade</button><button>Add Credits</button></div>';
        }""")
        page.wait_for_function("document.querySelector('#replacement [role=status]')?.textContent === 'Rated Limited'")
        assert page.locator('#replacement').inner_text() == 'Rated Limited'
        assert page.locator('#composer').input_value() == 'continue'

        # Native generated content appears in the editor's accessibility
        # subtree. Keep the hint visible outside that editable subtree.
        page.set_content('''<style>
            :root { --color-text-tertiary: #999; }
            .ProseMirror { padding: 8px; }
            .placeholder { position:relative; }
            .placeholder::before { content:attr(data-placeholder);position:absolute; }
            </style><div id="host"><div class="ProseMirror" contenteditable="true"
            role="textbox" aria-label="Flap"><p class="placeholder" data-placeholder="Flap"><br></p></div></div><button id="elsewhere">Elsewhere</button>''')
        cdp = page.context.new_cdp_session(page)
        def editor_value():
            nodes = cdp.send('Accessibility.getFullAXTree')['nodes']
            return next(node.get('value', {}).get('value', '') for node in nodes
                        if node.get('role', {}).get('value') == 'textbox')
        def accessible_hint_count():
            return sum(node.get('role', {}).get('value') == 'StaticText'
                       and node.get('name', {}).get('value') in ('Flap', 'Soar')
                       for node in cdp.send('Accessibility.getFullAXTree')['nodes'])
        assert accessible_hint_count() == 1
        placeholders = (ASSETS / 'placeholders.js').read_text().replace(
            '__SCM_TOOLKIT_PLACEHOLDERS__', '["Flap", "Soar"]')
        page.add_script_tag(content=placeholders)
        page.wait_for_function("document.querySelector('.scm-toolkit-placeholder-display')?.textContent === 'Flap'")
        assert editor_value().strip() == '', editor_value()
        assert accessible_hint_count() == 0
        assert page.locator('.scm-toolkit-placeholder-display').is_visible()
        for _ in range(3):
            page.locator('#elsewhere').focus()
            page.locator('.ProseMirror').focus()
            assert editor_value().strip() == ''
            assert accessible_hint_count() == 0
        page.locator('.ProseMirror').fill('Actual draft')
        page.eval_on_selector('.ProseMirror p', 'p => {p.className="";p.removeAttribute("data-placeholder")}')
        page.wait_for_function("!document.querySelector('.scm-toolkit-placeholder-display')")
        assert editor_value().strip() == 'Actual draft', editor_value()
        page.eval_on_selector('.ProseMirror', '''editor => {
            editor.innerHTML = '<p class="placeholder" data-placeholder="Soar"><br></p>';
        }''')
        page.wait_for_function("document.querySelector('.scm-toolkit-placeholder-display')?.textContent === 'Soar'")
        assert editor_value().strip() == '', editor_value()
        page.eval_on_selector('#host', 'host => host.remove()')
        page.wait_for_function("!document.querySelector('.scm-toolkit-placeholder-display')")
        assert not errors, errors
        print("PASS: custom placeholders stay visible outside the accessible editor value and survive draft changes")
        print("PASS: exhausted-message promotions retain Rated Limited initially and after dynamic insertion")
        print("PASS: Chromium usage accent with absent theme token, override and reset")
        print("PASS: headless Chromium computed CSS, header, activity and 75 React-style rewrites")
        # Queued previews repeat arbitrary user text in aria-label. They must
        # never be interpreted as native rate-limit statuses or attachments.
        queue_page = browser.new_page()
        queue_page.set_content("""<main><section id="composer-region">
          <div id="queue-row">
            <div data-scm-toolkit-rate-limit-pony-companion="true"><img id="old-decoration"></div>
            <div role="group" tabindex="0" aria-label="Preview queued message 1: rate limit reached">
              <span id="queued-copy">Rate limited</span><img id="real-attachment" src="user-image.png">
            </div><button aria-label="Queued message actions">More</button>
          </div><textarea id="queued-editor">Keep this draft</textarea>
        </section></main>""")
        rate_script = (ASSETS / 'rate-limit-controls.js').read_text().replace(
            '"__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__"', '"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="'
        ).replace('"__SCM_TOOLKIT_RATE_LIMIT_STICKER_ENABLED__"', 'true')
        queue_page.add_script_tag(content=rate_script)
        assert queue_page.evaluate('scmToolkitFooterRateLimitNotice(document).card === null')
        assert queue_page.locator('#queued-copy').inner_text() == 'Rate limited'
        assert queue_page.locator('#old-decoration').count() == 0
        assert queue_page.locator('#real-attachment').count() == 1
        assert queue_page.locator('#queued-editor').input_value() == 'Keep this draft'
        queue_page.evaluate("""() => {
          const status = document.createElement('div');
          status.id = 'native-limit'; status.setAttribute('role', 'status');
          status.textContent = 'Rate limited';
          document.querySelector('#composer-region').append(status);
          scmToolkitSyncRateLimitPony(document);
        }""")
        queue_page.wait_for_selector('#native-limit[data-scm-toolkit-rate-limit-pony] img')
        assert queue_page.locator('#queue-row [data-scm-toolkit-rate-limit-pony]').count() == 0
        assert queue_page.locator('#real-attachment').count() == 1
        queue_page.close()
        print('PASS: queued rate-limit prose is untouched; only native status gets artwork; real attachments survive')
        browser.close()

if __name__ == "__main__":
    run()
