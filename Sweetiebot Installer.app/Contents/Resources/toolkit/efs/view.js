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
        this.post({ type: 'copied', index: Number(message.index) });
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
body{padding:10px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family)}
form{display:flex;gap:6px}input,select,button{font:inherit;color:inherit}input,select{border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;padding:5px 7px}.search-input{position:relative;min-width:0;flex:1}.search-input input{box-sizing:border-box;width:100%;min-width:0;padding-right:30px}.search-input input::-webkit-search-cancel-button{display:none}.search-input .search-button{position:absolute;right:3px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;background:transparent;color:var(--vscode-input-foreground);border-radius:3px}.search-input .search-button:hover{background:var(--vscode-toolbar-hoverBackground)}.search-button:focus-visible{outline:1px solid var(--vscode-focusBorder)}select{max-width:84px}button{border:0;border-radius:3px;padding:5px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-button-border,var(--vscode-widget-border))}.actions{display:flex;gap:6px;margin:8px 0}.status{margin:8px 0;color:var(--vscode-descriptionForeground)}.warning{margin:8px 0;color:var(--vscode-editorWarning-foreground)}.error{margin:8px 0;color:var(--vscode-errorForeground)}.answer{white-space:pre-wrap;margin:8px 0;padding:8px;background:var(--vscode-textBlockQuote-background);border-left:2px solid var(--vscode-textBlockQuote-border)}.result{display:block;width:100%;text-align:left;margin:0;padding:8px 4px;border:0;border-top:1px solid var(--vscode-panel-border);border-radius:0;background:transparent;color:inherit}.result:hover{background:var(--vscode-list-hoverBackground)}.path{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.result-meta{float:right;display:inline-flex;align-items:center;gap:6px;margin-left:6px}.score{color:var(--vscode-textLink-foreground);font-weight:400}.copy-status{position:relative;display:inline-flex;width:14px;height:14px;flex:0 0 14px;align-items:center;justify-content:center;border-radius:50%;opacity:0;transform:scale(.65);transition:opacity .12s ease,transform .16s ease;--copy-check-color:#fff}.copy-status::before{content:'';position:absolute;inset:0;border-radius:50%;background:var(--vscode-focusBorder,var(--vscode-textLink-foreground));transform:scale(0);transition:transform .16s ease}.copy-status::after{content:'✓';position:relative;z-index:1;color:var(--copy-check-color);font-size:10px;font-weight:700;line-height:14px;opacity:0;transition:opacity .08s ease .08s}.copy-status.copied{opacity:1;transform:scale(1)}.copy-status.copied::before{transform:scale(1)}.copy-status.copied::after{opacity:1}.snippet{display:-webkit-box;margin-top:3px;color:var(--vscode-descriptionForeground);overflow:hidden;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:normal}.empty{padding:10px 0;color:var(--vscode-descriptionForeground)}
</style></head><body>
<form id="search"><div class="search-input"><input id="query" type="search" aria-label="Search your workspace" placeholder="Search your workspace…" autocomplete="off"><button class="search-button" type="submit" aria-label="Search" title="Search (Enter)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="m10 10 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div><select id="mode" title="Search mode"><option value="hybrid">Hybrid</option><option value="semantic">Semantic</option><option value="exact">Exact</option></select></form>
${actions}
<div id="status" class="status"></div><div id="answer"></div><div id="results"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const form=document.getElementById('search');const query=document.getElementById('query');const mode=document.getElementById('mode');const status=document.getElementById('status');const answer=document.getElementById('answer');const results=document.getElementById('results');const ask=document.getElementById('ask');
let searchTimer;let requestId=0;let submittedQuery='';let submittedMode='';let composing=false;let copiedIndicator;
function contrastCheckColor(value){const color=String(value||'').trim();let rgb;let match=color.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);if(match){let hex=match[1];if(hex.length===3||hex.length===4)hex=hex.slice(0,3).split('').map(char=>char+char).join('');else hex=hex.slice(0,6);rgb=[parseInt(hex.slice(0,2),16),parseInt(hex.slice(2,4),16),parseInt(hex.slice(4,6),16)]}else{match=color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);if(match)rgb=match.slice(1,4).map(Number)}if(!rgb||rgb.some(component=>!Number.isFinite(component)))return '#fff';const linear=component=>{const normalized=Math.max(0,Math.min(255,component))/255;return normalized<=.03928?normalized/12.92:Math.pow((normalized+.055)/1.055,2.4)};const luminance=.2126*linear(rgb[0])+.7152*linear(rgb[1])+.0722*linear(rgb[2]);return luminance>.5?'#000':'#fff'}
function showCopyConfirmation(index){const indicator=results.querySelector('[data-index="'+Number(index)+'"] .copy-status');if(!indicator)return;if(copiedIndicator&&copiedIndicator!==indicator)copiedIndicator.classList.remove('copied');const styles=getComputedStyle(document.documentElement);const accent=styles.getPropertyValue('--vscode-focusBorder').trim()||styles.getPropertyValue('--vscode-textLink-foreground').trim();indicator.style.setProperty('--copy-check-color',contrastCheckColor(accent));indicator.classList.remove('copied');void indicator.offsetWidth;indicator.classList.add('copied');copiedIndicator=indicator}
function clearResults(){answer.textContent='';answer.className='';results.replaceChildren();copiedIndicator=undefined;status.textContent='';status.className='status';if(ask)ask.disabled=true}
function search(){clearTimeout(searchTimer);if(composing)return;submittedQuery=query.value.trim();submittedMode=mode.value;clearResults();vscode.postMessage({type:'search',query:submittedQuery,mode:submittedMode,requestId:++requestId})}
function scheduleSearch(){clearTimeout(searchTimer);if(ask)ask.disabled=true;if(!query.value.trim()){search();return}if(!composing)searchTimer=setTimeout(search,350)}
form.addEventListener('submit',event=>{event.preventDefault();search()});
query.addEventListener('input',scheduleSearch);
query.addEventListener('compositionstart',()=>{composing=true;clearTimeout(searchTimer)});
query.addEventListener('compositionend',()=>{composing=false;scheduleSearch()});
mode.addEventListener('change',search);
ask?.addEventListener('click',()=>vscode.postMessage({type:'ask'}));
results.addEventListener('click',event=>{const button=event.target.closest('[data-index]');if(button)vscode.postMessage({type:'open',index:Number(button.dataset.index)})});
results.addEventListener('contextmenu',event=>{const button=event.target.closest('[data-index]');if(button){event.preventDefault();vscode.postMessage({type:'copyPath',index:Number(button.dataset.index)})}});
window.addEventListener('message',event=>{const message=event.data;if(message.requestId!==undefined&&(message.requestId!==requestId||query.value.trim()!==submittedQuery||mode.value!==submittedMode))return;if(message.type==='copied'){showCopyConfirmation(message.index);return}if(message.type==='busy'){status.className='status';status.textContent=message.label;return}if(message.type==='error'){status.className='error';status.textContent=message.message;return}if(message.type==='answer'){status.className='status';status.textContent='Answer from '+message.model;answer.className='answer';answer.textContent=message.answer;return}if(message.type==='results'){answer.textContent='';answer.className='';status.className=message.warning?'warning':'status';status.textContent=message.warning||message.results.length+' result'+(message.results.length===1?'':'s')+' · '+message.mode;if(ask)ask.disabled=!message.results.length;results.replaceChildren();if(!message.results.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching passages.';results.append(empty);return}message.results.forEach((result,index)=>{const button=document.createElement('button');button.type='button';button.className='result';button.dataset.index=String(index);const p=document.createElement('span');p.className='path';p.textContent=result.relative+':'+(result.line+1);const meta=document.createElement('span');meta.className='result-meta';const score=document.createElement('span');score.className='score';score.textContent=result.score.toFixed(2);const copied=document.createElement('span');copied.className='copy-status';copied.setAttribute('aria-hidden','true');meta.append(score,copied);p.append(meta);const snippet=document.createElement('span');snippet.className='snippet';snippet.textContent=result.text.replace(/\\s+/g,' ');button.append(p,snippet);results.append(button)})}});
query.focus();
</script></body></html>`;
  }
}

module.exports = { WorkspaceSearchViewProvider };
