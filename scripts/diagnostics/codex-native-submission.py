#!/usr/bin/env python3
"""Measure actual Codex questionnaire paste/Enter callbacks without a live host.

Run with uv run --with playwright python scripts/diagnostics/codex-native-submission.py
--extension /path/to/openai.chatgpt-26.1120.41243-darwin-arm64 --compare-ref HEAD.
Only supports the explicitly pinned native build. Native JavaScript is restored
in memory from reversible Sweetiebot metadata, never written to the installation.
Host RPC and Intl are inert fixtures; native React, ProseMirror and questionnaire
submission run unchanged. Timings exclude any backend/network operation.
"""

import argparse
import hashlib
import os
import statistics
import subprocess
import re
import json
from pathlib import Path

START = re.compile(r"/\*\s*((?:scm-toolkit|sweetiebot)-codex-[\w-]+):start\s*\*/")


def strip(s):
    while True:
        matches = list(START.finditer(s))
        if not matches:
            break
        m = matches[-1]
        end = re.search(r"/\*\s*" + re.escape(m[1]) + r":end\s*\*/", s[m.end() :])
        if not end:
            raise ValueError(m[1])
        payload = s[m.end() : m.end() + end.start()]
        s = s[: m.start()] + s[m.end() + end.end() :]
        edits = re.search(r"^/\* (edits?):(.*?) \*/$", payload, re.M)
        if edits:
            data = json.loads(edits[2])
            data = [data] if edits[1] == "edit" else data
            for old, new in reversed(data):
                if s.count(new) != 1:
                    raise ValueError("Count " + m[1] + " " + str(s.count(new)))
                s = s.replace(new, old, 1)
    marker = "/* scm-toolkit-codex-placeholders:start\n"
    if marker in s:
        a = s.index(marker)
        b = s.index("scm-toolkit-codex-placeholders:end */", a)
        edits = json.loads(s[a + len(marker) : b])
        s = s[:a] + s[b + len("scm-toolkit-codex-placeholders:end */") :]
        for old, new in reversed(edits):
            if s.count(new) != 1:
                raise ValueError("placeholder count")
            s = s.replace(new, old, 1)
    if re.search(r"scmToolkit|scm-toolkit|sweetiebot-codex", s):
        m = re.search(r"scmToolkit|scm-toolkit|sweetiebot-codex", s)
        raise ValueError("Unrestored " + s[max(0, m.start() - 100) : m.start() + 100])
    return s


ROOT = Path(__file__).resolve().parents[2]
CHUNKS = {
    "component": "app-initial-988212761857.js",
    "base": "app-initial-363d04a4b464.js",
    "scope": "app-initial-cfe401907590.js",
    "client": "client-65d633c840f8.js",
}
ASSETS = [
    "hide/chat-timestamps.js",
    "usage.js",
    "rate-limit-controls.js",
    "window-label.js",
]
SETUP = r"""async chunks=>{
 window.acquireVsCodeApi=()=>({postMessage(){},getState:()=>({}),setState(){}});
 const m=await import('/'+chunks.component),base=await import('/'+chunks.base),client=await import('/'+chunks.client),scoped=await import('/'+chunks.scope);
 m.oc();const React=base.Ant();window.reactCommits=[];window.answers=[];
 const questionnaire=React.createElement(m.ic,{productSurface:'work',autoFocus:true,
 questionAndOptions:[{id:'q',question:React.createElement('span',{},'Answer the question'),isOther:true,options:[]}],
 onSubmit:value=>answers.push({value,at:performance.now()})});
 const provided=React.createElement(base.hz,{queryClient:new base.wV({defaultOptions:{queries:{retry:false}}})},
 React.createElement(base.pz,{scope:scoped.JPn,value:{}},
 React.createElement(window.__REACT_INTL_CONTEXT__.Provider,{value:{locale:'en',formatMessage:(message)=>message.defaultMessage??message.id}},questionnaire)));
 client.t().createRoot(document.getElementById('root')).render(React.createElement(React.Profiler,{id:'questionnaire',onRender:(...args)=>reactCommits.push({phase:args[1],duration:args[2]})},provided));
}"""
INSTRUMENT = r"""n=>{
 window.fixture=Array.from({length:n},(_,i)=>`<article data-message-id="${i}"><div class="message-title"><span>Message ${i}</span></div><div><p>Paragraph ${i} routine message content.</p><p>Additional text ${i}</p></div></article>`).join('');
 window.profile={observers:{},pastes:0,keys:0,longTasks:[]};
 const Native=MutationObserver;
 window.MutationObserver=class extends Native{constructor(callback){const label=window.loadingAsset;super((records,self)=>{const start=performance.now();try{callback(records,self)}finally{const e=profile.observers[label]??={calls:0,ms:0,max:0};const ms=performance.now()-start;e.calls++;e.ms+=ms;e.max=Math.max(e.max,ms)}})}};
 new PerformanceObserver(list=>profile.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
 document.addEventListener('paste',()=>profile.pastes++,true);
 document.addEventListener('keydown',e=>{if(e.key==='Enter')profile.keys++},true);
}"""
MEASURE = r"""async({rounds,active})=>{
 const field=document.querySelector('[contenteditable=true]');const times=[],pasteTimes=[],keyTimes=[];
 for(let i=0;i<rounds;i++){
  const start=performance.now();
  if(i===0)document.getElementById('history').innerHTML=fixture;
  else if(active)document.querySelector('#history article:last-child p').textContent='Streaming '+i;
  await new Promise(resolve=>setTimeout(()=>{
   const data=new DataTransfer();data.setData('text/plain','Answer '+i);
   const p=performance.now();field.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));pasteTimes.push(performance.now()-p);
   resolve();
  },0));
  // Let native React/ProseMirror persist the pasted answer before native Enter.
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const count=answers.length,k=performance.now();
  field.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter'}));
  keyTimes.push(performance.now()-k);
  await new Promise(resolve=>setTimeout(resolve,0));
  if(answers.length!==count+1)throw Error('Native questionnaire did not submit once');
  if(!JSON.stringify(answers.at(-1).value).includes('Answer '+i))throw Error('Native answer missing pasted text');
  times.push(answers.at(-1).at-start);
  field.focus();document.execCommand('selectAll');document.execCommand('delete');
  await new Promise(resolve=>requestAnimationFrame(resolve));
 }
 return{times,pasteTimes,keyTimes,profile,answers:answers.length,reactCommits};
}"""


def asset(name, revision=None):
    relative = "assets/codex/" + name
    text = (
        subprocess.check_output(
            ["git", "show", f"{revision}:{relative}"], cwd=ROOT, text=True
        )
        if revision
        else (ROOT / relative).read_text()
    )
    return (
        text.replace("__SCM_TOOLKIT_CODEX_WINDOW_LABEL__", '"CelestAI"')
        .replace('"__SCM_TOOLKIT_RATE_LIMIT_STICKER_ENABLED__"', "false")
        .replace("__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__", "data:image/png;base64,AA==")
    )


def run():
    from playwright.sync_api import sync_playwright

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--compare-ref")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--trace-dir",
        type=Path,
        help="Optional Chromium timeline traces; use a disposable directory",
    )
    parser.add_argument("--messages", type=int, default=1500)
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()
    if args.trace_dir:
        args.trace_dir.mkdir(parents=True, exist_ok=True)
    package = json.loads((args.extension / "package.json").read_text())
    if package["version"] != "26.1120.41243":
        raise ValueError(
            "Unsupported native build; update explicit export contracts first"
        )
    native = args.extension / "webview/assets"
    for filename in CHUNKS.values():
        if not (native / filename).is_file():
            raise ValueError("Unsupported native chunks: " + filename)
    restored = {}
    hashes = {}
    errors = []
    reports = []

    def route(request):
        filename = request.request.url.split("/")[-1]
        if "/" in filename or ".." in filename:
            raise ValueError("Invalid asset route")
        file = native / filename
        if file.is_file() and file.suffix == ".js":
            if filename not in restored:
                source = file.read_text()
                restored[filename] = strip(source)
                hashes[filename] = {
                    "installed_sha256": hashlib.sha256(source.encode()).hexdigest(),
                    "restored_sha256": hashlib.sha256(
                        restored[filename].encode()
                    ).hexdigest(),
                }
            request.fulfill(body=restored[filename], content_type="text/javascript")
        elif filename == "":
            request.fulfill(
                body='<html data-codex-window-type="extension"><head></head><body><header><h1>Codex</h1></header><main id="history"></main><section id="root"></section></body></html>',
                content_type="text/html",
            )
        else:
            request.fulfill(body="", content_type="text/plain")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get("CODEX_TEST_CHROMIUM") or None, headless=True
        )
        variants = (
            [("native", None, [])]
            + ([("before", args.compare_ref, ASSETS)] if args.compare_ref else [])
            + [("after", None, ASSETS)]
        )
        for mode, revision, scripts in variants:
            for active in [False, True]:
                page = browser.new_page()
                page.route("https://native.test/**", route)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto("https://native.test/")
                page.evaluate(SETUP, CHUNKS)
                page.locator("[contenteditable=true]").wait_for()
                page.wait_for_timeout(100)
                if args.trace_dir:
                    browser.start_tracing(
                        page=page,
                        path=str(args.trace_dir / f"{mode}-{active}.json"),
                        categories=[
                            "devtools.timeline",
                            "v8.execute",
                            "blink.user_timing",
                        ],
                    )
                page.evaluate(INSTRUMENT, args.messages)
                for name in scripts:
                    page.evaluate("name=>window.loadingAsset=name", name)
                    page.add_script_tag(content=asset(name, revision))
                page.wait_for_timeout(80)
                result = page.evaluate(
                    MEASURE, {"rounds": args.rounds, "active": active}
                )
                if args.trace_dir:
                    browser.stop_tracing()
                assert not errors, errors
                assert (
                    result["profile"]["pastes"] == args.rounds
                    and result["profile"]["keys"] == args.rounds
                )
                reports.append(
                    {
                        "mode": mode,
                        "conversation": "active" if active else "idle",
                        "messages": args.messages,
                        "remount_paste_to_native_callback_ms": round(
                            result["times"][0], 2
                        ),
                        "native_callback_p50_ms": round(
                            statistics.median(result["times"][1:]), 2
                        ),
                        "paste_handler_max_ms": round(max(result["pasteTimes"]), 2),
                        "keydown_handler_max_ms": round(max(result["keyTimes"]), 2),
                        "profile": result["profile"],
                        "native_submissions": result["answers"],
                        "react_commits": result["reactCommits"],
                        "react_profiler_available": bool(result["reactCommits"]),
                    }
                )
                page.close()
        browser.close()
    report = {
        "host": "Actual native Codex questionnaire, React and ProseMirror; inert host RPC/Intl; no backend timings",
        "codex_version": package["version"],
        "restored_native_chunks": hashes,
        "results": reports,
    }
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    for row in reports:
        print(
            json.dumps(
                {k: v for k, v in row.items() if k not in ["profile", "react_commits"]}
            )
        )


if __name__ == "__main__":
    run()
