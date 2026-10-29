'use strict';
// Run under Electron: exercise the real sandbox, CSP, native IPC, DOM collector,
// and loopback confirmation page without ChatGPT credentials or Git mutations.
const {app, BrowserWindow, protocol} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const {createMergeHandoff} = require(path.join(root, 'extension/merge/handoff'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-electron-transport-'));
app.setPath('userData', path.join(temporary, 'profile'));
let bridge, win, executions = 0;
const deadline = setTimeout(() => finish(Error('Native prompt transport timed out.')), 25000);
function finish(error) {
  clearTimeout(deadline);
  bridge?.dispose();
  win?.destroy();
  if (error) console.error(error);
  else console.log('Real Electron sandbox, strict CSP, short prompt transport and JSON callback passed.');
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  const prompt = 'Inspect this selected fake batch. 🪄\n'.repeat(1500);
  bridge = await createMergeHandoff({repository:'test/fixture',pullRequests:[{
    number:1,title:'Fixture',head:'topic',base:'main',headSha:'a'.repeat(40),url:'https://github.com/test/fixture/pull/1'
  }]}, {validate(input){assert.equal(input.repository,'test/fixture');assert.deepEqual(input.results,[]);},
    async execute(){executions++;return {repository:'test/fixture',results:[],validated:true};},
    onResult(){
      assert.equal(executions,1);
      setTimeout(async()=>{
        try {assert.match(await win.webContents.executeJavaScript('document.getElementById("status").textContent'),/^No pull requests were delegated/);finish();}
        catch(error){finish(error);}
      },500);
    }});
  bridge.setPrompt(prompt);
  const preload = path.join(temporary, 'preload.cjs');
  fs.writeFileSync(preload, 'globalThis.sweetiebotEnsureMaximumThinking=()=>true;\n'
    + fs.readFileSync(path.join(root,'assets/browser/pull_request_submit.js'),'utf8'));
  await protocol.handle('https', request => {
    assert.equal(new URL(request.url).origin,'https://chatgpt.com');
    assert(request.url.length<1000,'Prompt text must never enter a browser request URL');
    assert([...request.headers].reduce((size,[key,value])=>size+key.length+value.length+4,0)<16384,'Workflow browser headers stay below the local server budget');
    return new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-fixture'; style-src 'unsafe-inline'; connect-src 'none'"><textarea id="prompt-textarea"></textarea><button aria-label="Send prompt">Send</button><script nonce="fixture">
      document.querySelector('button').onclick=()=>{
        const actual=document.querySelector('textarea').value,expected=${JSON.stringify(prompt)}; if(actual!==expected) throw Error('Prompt was truncated '+actual.length+'/'+expected.length+' first difference '+Array.from({length:expected.length},(_,i)=>i).find(i=>actual[i]!==expected[i]));
        if(location.href!=='https://chatgpt.com/') throw Error('Launch metadata leaked');
        document.querySelector('button').disabled=true;
        const article=document.createElement('article'); article.dataset.testid='conversation-turn-1';
        const marker=document.createElement('div');marker.dataset.conversationRole='assistant';article.append(marker);
        const pre=document.createElement('pre');pre.textContent=JSON.stringify({version:1,repository:'test/fixture',results:[]});article.append(pre);document.body.append(article);
      };
    </script>`, {headers:{'content-type':'text/html'}});
  });
  win = new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true}});
  // Install the same per-WebContents native bridge the VS Code installer uses.
  new Function(fs.readFileSync(path.join(root,'assets/browser/pr_background.js'),'utf8'))
    .call({_view:{webContents:win.webContents}});
  win.webContents.on('preload-error',(_event,_file,error)=>finish(error));
  win.webContents.on('console-message',(...args)=>{
    const message=args[0]?.message ?? (typeof args[1]==='object'?args[1].message:args[2]);
    if (/Sweetiebot merge launch:|Prompt was truncated|Launch metadata leaked/.test(message||'')) finish(Error(message));
  });
  const launch='https://chatgpt.com/?sweetiebot_launch=fixture#'+new URLSearchParams({sweetiebot_merge:'1',return_to:bridge.url});
  assert(launch.length<300);
  await win.loadURL(launch);
}).catch(finish);
