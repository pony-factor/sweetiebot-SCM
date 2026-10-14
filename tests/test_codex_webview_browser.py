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
        title = (ASSETS / "codex-window-label.js").read_text().replace(
            "__SCM_TOOLKIT_CODEX_WINDOW_LABEL__", '"CelestAI"'
        )
        page.add_script_tag(content=title)
        timestamp = (ASSETS / "codex-hide-chat-timestamps.js").read_text()
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
        page.add_script_tag(content=(ASSETS / "codex-usage.js").read_text())
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
        page.add_script_tag(content=(ASSETS / "codex-hide-promotions.js").read_text())
        assert not page.locator('#upsell').is_visible()
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
        page.wait_for_function("getComputedStyle(document.querySelector('#replacement')).display === 'none'")
        assert page.locator('#composer').input_value() == 'continue'
        assert not errors, errors
        print("PASS: exhausted-message promotions hidden initially and after dynamic insertion")
        print("PASS: Chromium usage accent with absent theme token, override and reset")
        print("PASS: headless Chromium computed CSS, header, activity and 75 React-style rewrites")
        browser.close()

if __name__ == "__main__":
    run()
