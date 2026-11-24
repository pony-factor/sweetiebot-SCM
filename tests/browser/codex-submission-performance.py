#!/usr/bin/env python3
"""Measure shared Codex overrides in an isolated Chromium DOM host.

Run with uv run --with playwright python tests/browser/codex-submission-performance.py.
--compare-ref HEAD compares the trial's starting assets with the current files.
This measures event delivery/observer work, not a Codex backend round trip.
"""
from pathlib import Path
import argparse
import json
import os
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ['hide/chat-timestamps.js', 'usage.js', 'rate-limit-controls.js', 'window-label.js']
HTML = '''<html data-codex-window-type="extension"><head></head><body>
<header><h1>Codex</h1></header><main id="history"></main>
<section data-composer-surface-variant="default"><div data-composer-body>
<div contenteditable="true" role="textbox" id="editor"><p>Draft</p></div>
<button data-composer-navigation-target="model">GPT-6 Medium</button>
<button class="bg-composer-primary" aria-label="Send">Send</button></div></section>
<div role="dialog"><textarea id="question" aria-label="Answer"></textarea></div>
</body></html>'''
INSTRUMENT = r'''n => {
 const history=document.getElementById('history');
 window.fixture=Array.from({length:n},(_,i)=>`<article data-message-id="${i}"><div class="message-title"><span>Message ${i}</span></div><div><p>Paragraph ${i} routine message content.</p><p>Additional text ${i}</p></div></article>`).join('');
 history.innerHTML=fixture;
 window.textSize=history.textContent.length;
 window.profile={observers:{},textReadChars:0,documentScans:0,callbacks:0,pastes:0,enters:0,longTasks:[]};
 const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
 Object.defineProperty(Node.prototype,'textContent',{...descriptor,get(){const value=descriptor.get.call(this);profile.textReadChars+=value?.length||0;return value;}});
 const query=Document.prototype.querySelectorAll;
 Document.prototype.querySelectorAll=function(...args){profile.documentScans++;return query.apply(this,args)};
 const Native=MutationObserver;
 window.MutationObserver=class extends Native { constructor(callback){
  const label=window.loadingAsset;
  super((records,self)=>{const start=performance.now();try{callback(records,self)}finally{
   const entry=profile.observers[label]??={calls:0,ms:0,max:0};const elapsed=performance.now()-start;
   entry.calls++;entry.ms+=elapsed;entry.max=Math.max(entry.max,elapsed);
  }});
 }};
 new PerformanceObserver(list=>profile.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
 for(const id of ['editor','question']){
  const field=document.getElementById(id);
  field.addEventListener('paste',event=>{profile.pastes++;event.preventDefault();const text=event.clipboardData.getData('text/plain');
   if(field.tagName==='TEXTAREA')field.value=text;else field.firstChild.textContent=text;
   field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:text}));});
  field.addEventListener('keydown',event=>{if(event.key==='Enter'){profile.enters++;window.callbackAt=performance.now();}});
 }
 window.resetProfile=()=>{profile.observers={};profile.textReadChars=0;profile.documentScans=0;profile.pastes=0;profile.enters=0;profile.longTasks=[];};
}'''
MEASURE = r'''async ({active,rounds}) => {
 resetProfile();const times=[];const timerDelays=[];
 for(let i=0;i<rounds;i++){
  const start=performance.now();
  // Simulate a React transcript remount before the browser delivers a pending
  // native input task. The input task cannot run until observer microtasks end.
  if(i===0)document.getElementById('history').innerHTML=fixture;
  else if(active)document.querySelector('#history article:last-child p').textContent='Streaming response '+i;
  await new Promise(resolve=>setTimeout(()=>{
   timerDelays.push(performance.now()-start);
   const field=document.getElementById(i%2?'question':'editor');
   const clipboard=new DataTransfer();clipboard.setData('text/plain','Answer '+i);
   field.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));
   field.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'}));
   times.push(callbackAt-start);resolve();
  },0));
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 return {times,timerDelays,profile:JSON.parse(JSON.stringify(profile)),textSize};
}'''


def source(name, revision=None):
    relative = 'assets/codex/' + name
    text = (subprocess.check_output(['git', 'show', f'{revision}:{relative}'], cwd=ROOT, text=True)
            if revision else (ROOT / relative).read_text())
    return text.replace('__SCM_TOOLKIT_CODEX_WINDOW_LABEL__', '"CelestAI"').replace(
        '"__SCM_TOOLKIT_RATE_LIMIT_STICKER_ENABLED__"', 'false').replace(
        '__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__', 'data:image/png;base64,AA==')


def percentile(values, fraction):
    return round(sorted(values)[min(len(values)-1, int((len(values)-1)*fraction))], 2)


def run():
    from playwright.sync_api import sync_playwright
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--messages', type=int, default=1500)
    parser.add_argument('--rounds', type=int, default=12)
    parser.add_argument('--compare-ref')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    reports = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CODEX_TEST_CHROMIUM') or None, headless=True)
        variants = [('no-overrides', None, [])]
        if args.compare_ref:
            variants.append(('before', args.compare_ref, ASSETS))
        variants.append(('after', None, ASSETS))
        for mode, revision, assets in variants:
            for active in [False, True]:
                page = browser.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.set_content(HTML)
                page.evaluate(INSTRUMENT, args.messages)
                start = page.evaluate('performance.now()')
                for name in assets:
                    page.evaluate('name => window.loadingAsset=name', name)
                    page.add_script_tag(content=source(name, revision))
                startup = page.evaluate('performance.now()') - start
                page.wait_for_timeout(80)
                result = page.evaluate(MEASURE, {'active': active, 'rounds': args.rounds})
                assert not errors, errors
                assert result['profile']['pastes'] == args.rounds
                assert result['profile']['enters'] == args.rounds
                if mode == 'after':
                    # Deterministic work bound, independent of CI machine speed.
                    # Old timestamp code reads aggregate transcript text once
                    # per leaf; the fixed observer shares one cache per batch.
                    assert result['profile']['textReadChars'] < result['textSize'] * (100 + args.rounds * 4), result
                    assert page.locator('h1').inner_text() == 'CelestAI'
                reports.append({'mode': mode, 'conversation': 'active' if active else 'idle',
                                'messages': args.messages, 'startup_ms': round(startup, 2),
                                'remount_to_callback_ms': round(result['times'][0], 2),
                                'callback_p50_ms': round(statistics.median(result['times'][1:]), 2),
                                'callback_p95_ms': percentile(result['times'][1:], .95),
                                'profile': result['profile']})
                page.close()
        browser.close()
    report = {'host': 'Chromium DOM fixture; callbacks exclude backend work', 'results': reports}
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in reports:
        print(json.dumps({k:v for k,v in row.items() if k != 'profile'}))


if __name__ == '__main__':
    run()
