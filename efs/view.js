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
      if (!query) return;
      this.lastQuery = query;
      this.post({ type: 'busy', label: 'Searching…' });
      try {
        const result = await this.index.search(query, message.mode);
        this.lastResults = result.results;
        this.post({ type: 'results', query, ...result });
      } catch (error) {
        this.post({ type: 'error', message: error.message });
      }
      return;
    }
    if (message?.type === 'open') {
      const result = this.lastResults[Number(message.index)];
      if (result) await this.openResult(result);
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
body{padding:10px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family)}
form{display:flex;gap:6px}input,select,button{font:inherit;color:inherit}input,select{border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;padding:5px 7px}input{min-width:0;flex:1}select{max-width:84px}button{border:0;border-radius:3px;padding:5px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-button-border,var(--vscode-widget-border))}.actions{display:flex;gap:6px;margin:8px 0}.status{margin:8px 0;color:var(--vscode-descriptionForeground)}.warning{margin:8px 0;color:var(--vscode-editorWarning-foreground)}.error{margin:8px 0;color:var(--vscode-errorForeground)}.answer{white-space:pre-wrap;margin:8px 0;padding:8px;background:var(--vscode-textBlockQuote-background);border-left:2px solid var(--vscode-textBlockQuote-border)}.result{display:block;width:100%;text-align:left;margin:0;padding:8px 4px;border:0;border-top:1px solid var(--vscode-panel-border);border-radius:0;background:transparent;color:inherit}.result:hover{background:var(--vscode-list-hoverBackground)}.path{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.score{float:right;color:var(--vscode-descriptionForeground);font-weight:400}.snippet{display:-webkit-box;margin-top:3px;color:var(--vscode-descriptionForeground);overflow:hidden;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:normal}.empty{padding:10px 0;color:var(--vscode-descriptionForeground)}
</style></head><body>
<form id="search"><input id="query" type="search" placeholder="Search your workspace…" autocomplete="off"><select id="mode" title="Search mode"><option value="hybrid">Hybrid</option><option value="semantic">Semantic</option><option value="exact">Exact</option></select><button type="submit">Search</button></form>
${actions}
<div id="status" class="status"></div><div id="answer"></div><div id="results"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const form=document.getElementById('search');const query=document.getElementById('query');const mode=document.getElementById('mode');const status=document.getElementById('status');const answer=document.getElementById('answer');const results=document.getElementById('results');const ask=document.getElementById('ask');
form.addEventListener('submit',event=>{event.preventDefault();const value=query.value.trim();if(value)vscode.postMessage({type:'search',query:value,mode:mode.value})});
ask?.addEventListener('click',()=>vscode.postMessage({type:'ask'}));
results.addEventListener('click',event=>{const button=event.target.closest('[data-index]');if(button)vscode.postMessage({type:'open',index:Number(button.dataset.index)})});
window.addEventListener('message',event=>{const message=event.data;if(message.type==='busy'){status.className='status';status.textContent=message.label;return}if(message.type==='error'){status.className='error';status.textContent=message.message;return}if(message.type==='answer'){status.className='status';status.textContent='Answer from '+message.model;answer.className='answer';answer.textContent=message.answer;return}if(message.type==='results'){answer.textContent='';answer.className='';status.className=message.warning?'warning':'status';status.textContent=message.warning||message.results.length+' result'+(message.results.length===1?'':'s')+' · '+message.mode;if(ask)ask.disabled=!message.results.length;results.replaceChildren();if(!message.results.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching passages.';results.append(empty);return}message.results.forEach((result,index)=>{const button=document.createElement('button');button.type='button';button.className='result';button.dataset.index=String(index);const p=document.createElement('span');p.className='path';p.textContent=result.relative+':'+(result.line+1);const score=document.createElement('span');score.className='score';score.textContent=Math.round(result.score*100)+'%';p.append(score);const snippet=document.createElement('span');snippet.className='snippet';snippet.textContent=result.text.replace(/\\s+/g,' ');button.append(p,snippet);results.append(button)})}});
query.focus();
</script></body></html>`;
  }
}

module.exports = { WorkspaceSearchViewProvider };
