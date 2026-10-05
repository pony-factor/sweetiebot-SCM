'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { TEXT_EXTENSIONS } = require('./extract');
const { ask } = require('./ollama');

class WorkspaceSearchViewProvider {
  constructor(index, getSettings) {
    this.index = index;
    this.getSettings = getSettings;
    this.view = undefined;
    this.lastQuery = '';
    this.lastResults = [];
    this.searchGeneration = 0;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => this.onMessage(message));
  }

  post(message) {
    this.view?.webview.postMessage(message);
  }

  async onMessage(message) {
    if (message?.type === 'search') {
      const query = String(message.query || '').trim();
      const generation = ++this.searchGeneration;
      const requestId = message.requestId;
      this.lastQuery = query;
      this.lastResults = [];
      if (!query) return;
      this.post({ type: 'busy', label: 'Searching…', requestId });
      try {
        const result = await this.index.search(query, message.mode);
        if (generation !== this.searchGeneration) return;
        this.lastResults = result.results;
        this.post({ type: 'results', query, ...result, requestId });
      } catch (error) {
        if (generation === this.searchGeneration) this.post({ type: 'error', message: error.message, requestId });
      }
      return;
    }
    if (message?.type === 'open') {
      const result = this.lastResults[Number(message.index)];
      if (result) await this.openResult(result);
      return;
    }
    if (message?.type === 'copyPath') {
      const result = this.lastResults[Number(message.index)];
      if (result) {
        const uri = vscode.Uri.parse(result.uri);
        const line = Math.max(0, result.line || 0) + 1;
        const link = vscode.Uri.from({
          scheme: vscode.env.uriScheme,
          authority: 'file',
          path: `${uri.path}:${line}`
        }).toString();
        const label = `${result.relative}:${line}`.replace(/[\\[\]]/g, '\\$&');
        await vscode.env.clipboard.writeText(`[${label}](${link})`);
      }
      return;
    }
    if (message?.type === 'ask') {
      if (this.getSettings().askOllama) await this.askOllama();
      return;
    }
  }

  async openResult(result) {
    const uri = vscode.Uri.parse(result.uri);
    const ext = path.extname(uri.path).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) {
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.min(Math.max(0, result.line || 0), Math.max(0, document.lineCount - 1));
      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(line, 0, line, 0)
      });
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  async askOllama() {
    if (!this.lastQuery || !this.lastResults.length) return;
    this.post({ type: 'busy', label: 'Asking Ollama…' });
    try {
      const settings = this.getSettings();
      const model = String(settings.chatModel || '').trim();
      if (!settings.askOllama || !model) throw new Error('Choose an Ask Ollama chat model in Sweetie Bot settings.');
      const answer = await ask(settings, model, this.lastQuery, this.lastResults);
      this.post({ type: 'answer', answer: answer || 'Ollama returned an empty answer.', model });
    } catch (error) {
      this.post({ type: 'error', message: error.message });
    }
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const askEnabled = Boolean(this.getSettings().askOllama);
    const askButton = askEnabled ? '<button id="ask" class="secondary" type="button" disabled>Ask Ollama</button>' : '';
    const actions = askEnabled ? `<div class="actions">${askButton}</div>` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{height:100%}body{box-sizing:border-box;min-height:100vh;margin:0;padding:10px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family);display:flex;flex-direction:column}
form{display:flex;gap:6px}input,select,button{font:inherit;color:inherit}input,select{border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;padding:5px 7px}.search-input{position:relative;min-width:0;flex:1}.search-input input{box-sizing:border-box;width:100%;min-width:0;padding-right:30px}.search-input input::-webkit-search-cancel-button{display:none}.search-input .search-button{position:absolute;right:3px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;background:transparent;color:var(--vscode-input-foreground);border-radius:3px}.search-input .search-button:hover{background:var(--vscode-toolbar-hoverBackground)}.search-button:focus-visible{outline:1px solid var(--vscode-focusBorder)}select{max-width:84px}button{border:0;border-radius:3px;padding:5px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-button-border,var(--vscode-widget-border))}.actions{display:flex;gap:6px;margin:8px 0}.status{margin:8px 0;color:var(--vscode-descriptionForeground)}.warning{margin:8px 0;color:var(--vscode-editorWarning-foreground)}.error{margin:8px 0;color:var(--vscode-errorForeground)}.answer{white-space:pre-wrap;margin:8px 0;padding:8px;background:var(--vscode-textBlockQuote-background);border-left:2px solid var(--vscode-textBlockQuote-border)}.search-content{position:relative;flex:1;min-height:0}.result{display:block;width:100%;text-align:left;margin:0;padding:8px 4px;border:0;border-top:1px solid var(--vscode-panel-border);border-radius:0;background:transparent;color:inherit}.result:hover{background:var(--vscode-list-hoverBackground)}.path{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.score{float:right;color:var(--vscode-textLink-foreground);font-weight:400}.snippet{display:-webkit-box;margin-top:3px;color:var(--vscode-descriptionForeground);overflow:hidden;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:normal}.empty{padding:10px 0;color:var(--vscode-descriptionForeground)}.idle-mark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden}.idle-mark[hidden]{display:none}.idle-mark svg{width:clamp(82px,36vw,150px);height:auto;color:var(--vscode-descriptionForeground);opacity:.13;filter:blur(.65px);transform:scale(.98);transition:opacity .18s ease,filter .18s ease}.idle-mark .efs-stroke{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.35}.idle-mark .efs-fill{fill:currentColor}
</style></head><body>
<form id="search"><div class="search-input"><input id="query" type="search" aria-label="Search your workspace" placeholder="Search your workspace…" autocomplete="off"><button class="search-button" type="submit" aria-label="Search" title="Search (Enter)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="m10 10 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div><select id="mode" title="Search mode"><option value="hybrid">Hybrid</option><option value="semantic">Semantic</option><option value="exact">Exact</option></select></form>
${actions}
<div class="search-content">
  <div id="status" class="status"></div><div id="answer"></div><div id="results"></div>
  <div id="idle" class="idle-mark" aria-hidden="true">
    <!-- Mirrors efs/media/efs.svg; source attribution remains in efs/THIRD_PARTY_NOTICES.md. -->
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g class="efs-stroke" transform="rotate(-7 12 12)">
        <path d="M3.4 5.1h15.7c1 0 1.8.8 1.8 1.8v10.2c0 1-.8 1.8-1.8 1.8H3.4c-.8 0-1.4-.6-1.4-1.4v-11c0-.8.6-1.4 1.4-1.4Z"/>
        <rect x="4.7" y="6.8" width="13.3" height="9.5" rx=".7"/>
        <path d="M5.9 9.1h4.2M13.1 9.1h3.6M5.9 14.2h2.2l.9-1.2 1.1 2.1 1.2-1.8 1.1 1.2h4.3"/>
        <path d="M19.2 7.4h.9M19.2 10.1h.9M19.2 12.8h.9M19.2 15.5h.9"/>
      </g>
      <path class="efs-fill" d="m11.1 10.4 2.2.1-1.1 1.8-.4-1-.9.1Z"/>
    </svg>
  </div>
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const form=document.getElementById('search');const query=document.getElementById('query');const mode=document.getElementById('mode');const status=document.getElementById('status');const answer=document.getElementById('answer');const results=document.getElementById('results');const idle=document.getElementById('idle');const ask=document.getElementById('ask');
let searchTimer;let requestId=0;let submittedQuery='';let submittedMode='';let composing=false;
function updateIdleState(){idle.hidden=Boolean(query.value.trim())}
function clearResults(){answer.textContent='';answer.className='';results.replaceChildren();status.textContent='';status.className='status';if(ask)ask.disabled=true;updateIdleState()}
function search(){clearTimeout(searchTimer);if(composing)return;submittedQuery=query.value.trim();submittedMode=mode.value;clearResults();vscode.postMessage({type:'search',query:submittedQuery,mode:submittedMode,requestId:++requestId})}
function scheduleSearch(){clearTimeout(searchTimer);if(ask)ask.disabled=true;updateIdleState();if(!query.value.trim()){search();return}if(!composing)searchTimer=setTimeout(search,350)}
form.addEventListener('submit',event=>{event.preventDefault();search()});
query.addEventListener('input',scheduleSearch);
query.addEventListener('compositionstart',()=>{composing=true;clearTimeout(searchTimer)});
query.addEventListener('compositionend',()=>{composing=false;scheduleSearch()});
mode.addEventListener('change',search);
ask?.addEventListener('click',()=>vscode.postMessage({type:'ask'}));
results.addEventListener('click',event=>{const button=event.target.closest('[data-index]');if(button)vscode.postMessage({type:'open',index:Number(button.dataset.index)})});
results.addEventListener('contextmenu',event=>{const button=event.target.closest('[data-index]');if(button){event.preventDefault();vscode.postMessage({type:'copyPath',index:Number(button.dataset.index)})}});
window.addEventListener('message',event=>{const message=event.data;if(message.requestId!==undefined&&(message.requestId!==requestId||query.value.trim()!==submittedQuery||mode.value!==submittedMode))return;if(message.type==='busy'){status.className='status';status.textContent=message.label;return}if(message.type==='error'){status.className='error';status.textContent=message.message;return}if(message.type==='answer'){status.className='status';status.textContent='Answer from '+message.model;answer.className='answer';answer.textContent=message.answer;return}if(message.type==='results'){answer.textContent='';answer.className='';status.className=message.warning?'warning':'status';status.textContent=message.warning||message.results.length+' result'+(message.results.length===1?'':'s')+' · '+message.mode;if(ask)ask.disabled=!message.results.length;results.replaceChildren();if(!message.results.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching passages.';results.append(empty);return}message.results.forEach((result,index)=>{const button=document.createElement('button');button.type='button';button.className='result';button.dataset.index=String(index);const p=document.createElement('span');p.className='path';p.textContent=result.relative+':'+(result.line+1);const score=document.createElement('span');score.className='score';score.textContent=result.score.toFixed(2);p.append(score);const snippet=document.createElement('span');snippet.className='snippet';snippet.textContent=result.text.replace(/\\s+/g,' ');button.append(p,snippet);results.append(button)})}});
updateIdleState();
query.focus();
</script></body></html>`;
  }
}

module.exports = { WorkspaceSearchViewProvider };
