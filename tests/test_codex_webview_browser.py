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
from playwright.sync_api import sync_playwright

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
<article data-message-id="m1"><p>Meet at <span id="prose">9:18 PM</span></p><span id="message">CelestAI: Codex, says the message</span></article>
<button id="activity" aria-expanded="false" aria-label="Worked for 1m 48s">Worked for 1m 48s</button>
<div id="ordinary">9:18 PM is not a separator</div>
</body></html>"""

def run():
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
        for selector in ["#summary", "#prose", "#message", "#ordinary"]:
            assert state(selector)["display"] != "none", (selector, state(selector))
        assert state("#title")["text"] == "CelestAINew Chat"
        assert state("#activity")["text"] == "Activity"
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

        # The label must persist after the host rebuilds a header with controls.
        page.eval_on_selector("#title", """el => {
            el.innerHTML = '<span>CelestAI:</span><span> Codex</span><button>New Chat</button>';
        }""")
        page.wait_for_timeout(50)
        assert state("#title")["text"] == "CelestAINew Chat"
        assert not errors, errors
        print("PASS: headless Chromium computed CSS, header, activity and 75 React-style rewrites")
        browser.close()

if __name__ == "__main__":
    run()
