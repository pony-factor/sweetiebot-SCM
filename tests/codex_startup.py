import json
import subprocess
import unittest

import codex_startup


SOURCE = '''async function initialize(webview) {
let watchdog=new Watchdog(event=>{this.logger.error("Webview renderer did not become ready");webview.html="failed";errors++});
webview.html=await this.getWebviewContent(webview);watchdog.start();return watchdog;
}'''


class CodexStartupTests(unittest.TestCase):
    def test_patch_is_reversible_idempotent_and_guarded(self):
        patched = codex_startup.transform(SOURCE)
        subprocess.run(['node', '--check'], input=patched, text=True, check=True)
        self.assertEqual(codex_startup.transform(patched), patched)
        self.assertEqual(codex_startup.transform(patched, remove=True), SOURCE)
        for invalid in ['', SOURCE + SOURCE, SOURCE + codex_startup.START]:
            with self.assertRaises(ValueError):
                codex_startup.transform(invalid)
        with self.assertRaisesRegex(ValueError, 'patch changed'):
            codex_startup.transform(patched.replace('sweetiebotStartupRetried=false', 'sweetiebotStartupRetried=true', 1))

    def test_retry_restarts_renderer_once_and_keeps_real_failures_visible(self):
        script = '''
const assert=require('node:assert/strict');
let errors=0;
class Watchdog {
 constructor(onTimeout){this.onTimeout=onTimeout;this.starts=0;this.disposed=false;}
 start(){this.starts++;}
}
SOURCE
(async()=>{
 const writes=[];
 const view={set html(value){writes.push(value)}};
 let reads=0;
 const provider={logger:{error(){}},async getWebviewContent(){reads++;return 'renderer'}};
 const watchdog=await initialize.call(provider,view);
 await watchdog.onTimeout({});
 assert.equal(reads,2);assert.equal(watchdog.starts,2);
 assert.deepEqual(writes,['renderer','','renderer']);
 assert.equal(errors,0,'first timeout retries instead of destroying the panel');
 await watchdog.onTimeout({});
 assert.equal(reads,2);assert.equal(errors,1);
 assert.equal(writes.at(-1),'failed','a persistent failure remains visible');

 const lateWrites=[];
 const lateView={set html(value){lateWrites.push(value)}};
 let release;
 const late=await initialize.call(provider,lateView);
 provider.getWebviewContent=()=>new Promise(resolve=>{release=resolve});
 const retry=late.onTimeout({});
 late.disposed=true;release('renderer');await retry;
 assert.deepEqual(lateWrites,['renderer'],'never replace a renderer that became ready or was closed');

 provider.getWebviewContent=async()=> 'renderer';
 const broken=await initialize.call(provider,view);
 provider.getWebviewContent=async()=>{throw new Error('missing assets')};
 await broken.onTimeout({});
 assert.equal(errors,2,'failed content reload preserves the normal error');
})().catch(error=>{console.error(error);process.exitCode=1});
'''.replace('SOURCE', codex_startup.transform(SOURCE))
        subprocess.run(['node', '-e', script], check=True)
