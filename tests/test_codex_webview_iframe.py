#!/usr/bin/env python3
"""Exercise Codex assets inside a Chromium iframe hosted by a mock VS Code shell.

Run: python tests/test_codex_webview_iframe.py
Requires Playwright and Chromium; normal unittest discovery has no dependency.
"""

from html import escape
from pathlib import Path
import os
import shutil

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "codex"

WEBVIEW = """<html><head><style>
body { background: #111; color: white }
#clock { display: inline-block !important; }
</style></head><body>
<header><div id="title"><span>CelestAI:</span><span> Codex</span><button>New Chat</button></div></header>
<div id="row"><span id="clock"><span>9:</span><span>18 PM</span></span><span id="summary">Ran commands</span></div>
</body></html>"""

def run():
    from playwright.sync_api import sync_playwright

    host = (
        '<html><head><style>body{background:#171717;color:white}</style></head>'
        '<body><h1>VS Code mock extension host</h1><div id="hosttime">9:18 PM</div>'
        '<iframe title="Codex webview" name="codex" id="codex-webview" '
        'sandbox="allow-scripts allow-same-origin" '
        f'srcdoc="{escape(WEBVIEW, quote=True)}" '
        'style="height:500px;width:550px;border:none"></iframe></body></html>'
    )
    path = os.environ.get("CODEX_TEST_CHROMIUM") or shutil.which("chromium") or shutil.which("chromium-browser")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=path or None, headless=True, args=["--no-sandbox"]
        )
        page = browser.new_page(viewport={"width": 800, "height": 700})
        page.set_content(host)
        frame = page.frame(name="codex")
        assert frame is not None
        title = (ASSETS / "codex-window-label.js").read_text().replace(
            "__SCM_TOOLKIT_CODEX_WINDOW_LABEL__", '"CelestAI"'
        )
        frame.add_script_tag(content=title)
        frame.add_script_tag(content=(ASSETS / "codex-hide-chat-timestamps.js").read_text())
        frame.wait_for_function("getComputedStyle(document.getElementById('clock')).display === 'none'")
        assert frame.locator("#title").text_content() == "CelestAINew Chat"
        assert frame.locator("#summary").text_content() == "Ran commands"
        assert page.locator("#hosttime").evaluate("(e) => getComputedStyle(e).display") != "none"
        assert page.locator("h1").inner_text() == "VS Code mock extension host"

        # A host inline style cannot reveal the timestamp in the iframe.
        frame.locator("#clock").evaluate(
            '(el) => el.style.setProperty("display", "inline-flex", "important")'
        )
        frame.wait_for_function("getComputedStyle(document.getElementById('clock')).display === 'none'")
        print("PASS: sandboxed webview iframe, host CSS isolated, hidden timestamp and CelestAI label")
        browser.close()

if __name__ == "__main__":
    run()
