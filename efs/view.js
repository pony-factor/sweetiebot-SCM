'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { TEXT_EXTENSIONS } = require('./extract');
const { ask } = require('./ollama');

function groupSearchResults(items) {
  const groups = [];
  const byFile = new Map();
  (items || []).forEach((result, index) => {
    const key = String(result?.uri || result?.relative || index);
    let group = byFile.get(key);
    if (!group) {
      group = { relative: String(result?.relative || ''), entries: [] };
      byFile.set(key, group);
      groups.push(group);
    }
    group.entries.push({ result, index });
  });
  return groups;
}

function splitResultPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return {
    folders: parts.slice(0, -1),
    filename: parts.length ? parts[parts.length - 1] : normalized
  };
}

function formatResultScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '';
  return value.toFixed(2).replace(/^0(?=\.)/, '');
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

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
        const folder = result.kind === 'folder';
        const line = Math.max(0, result.line || 0) + 1;
        const link = vscode.Uri.from({
          scheme: vscode.env.uriScheme,
          authority: 'file',
          path: folder ? uri.path : `${uri.path}:${line}`
        }).toString();
        const label = (folder ? result.relative : `${result.relative}:${line}`).replace(/[\\[\]]/g, '\\$&');
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
    if (result.kind === 'folder') {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
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
    const searchPlaceholder = escapeHtmlAttribute(this.getSettings().placeholder || 'Search your workspace…');
    const askButton = askEnabled ? '<button id="ask" class="secondary" type="button" disabled>Ask Ollama</button>' : '';
    const actions = askEnabled ? `<div class="actions">${askButton}</div>` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{height:100%}body{box-sizing:border-box;min-height:100vh;margin:0;padding:10px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family);display:flex;flex-direction:column}
form{display:flex;gap:6px}input,select,button{font:inherit;color:inherit}input,select{border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:999px;min-height:30px;padding:5px 11px}.search-input{position:relative;display:flex;min-width:0;flex:1}.search-input input{box-sizing:border-box;width:100%;min-width:0;padding-right:64px}.search-input input::-webkit-search-cancel-button{display:none}.search-input .search-button,.search-input .clear-button{position:absolute;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;background:transparent;color:var(--vscode-input-foreground);border-radius:999px}.search-input .search-button{right:8px}.search-input .clear-button{right:34px}.search-input .clear-button[hidden]{display:none}.search-input .search-button:hover,.search-input .clear-button:hover{background:var(--vscode-toolbar-hoverBackground)}.search-button:focus-visible,.clear-button:focus-visible{outline:1px solid var(--vscode-focusBorder)}.search-mode{position:relative;display:flex;flex-shrink:0}.search-mode::after{content:"";position:absolute;right:12px;top:50%;width:5px;height:5px;border-right:1.5px solid var(--vscode-input-foreground);border-bottom:1.5px solid var(--vscode-input-foreground);transform:translateY(-70%) rotate(45deg);pointer-events:none}select{appearance:none;max-width:84px;padding-right:28px}button{border:0;border-radius:3px;padding:5px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-button-border,var(--vscode-widget-border))}.actions{display:flex;gap:6px;margin:8px 0}.status{margin:8px 0;color:var(--vscode-descriptionForeground)}.warning{margin:8px 0;color:var(--vscode-editorWarning-foreground)}.error{margin:8px 0;color:var(--vscode-errorForeground)}.status:empty,.warning:empty,.error:empty{display:none}.answer{white-space:pre-wrap;margin:8px 0;padding:8px;background:var(--vscode-textBlockQuote-background);border-left:2px solid var(--vscode-textBlockQuote-border)}.search-content{position:relative;flex:1;min-height:0}.file-group{border-top:1px solid var(--vscode-panel-border)}.file-heading{display:grid;grid-template-columns:14px minmax(0,1fr);grid-template-rows:auto auto;column-gap:4px;width:100%;min-width:0;padding:8px 4px 4px;overflow:hidden;text-align:left;background:transparent;color:inherit;border:0;border-radius:0;cursor:pointer}.file-heading:hover{background:var(--vscode-list-hoverBackground)}.file-heading:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.folder-tree{grid-column:1;grid-row:1 / span 2;position:relative;align-self:stretch;min-height:28px}.folder-tree::before{content:'';position:absolute;left:6px;top:7px;bottom:7px;border-left:1px solid var(--vscode-tree-indentGuidesStroke,var(--vscode-widget-border))}.folder-tree::after{content:'';position:absolute;left:6px;bottom:7px;width:7px;border-bottom:1px solid var(--vscode-tree-indentGuidesStroke,var(--vscode-widget-border))}.folder-route{grid-column:2;grid-row:1;display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size)*.92)}.folder-route::before{content:'▾';padding-right:4px;color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground))}.folder-segment{display:inline}.folder-segment:not(:last-child)::after{content:' › ';color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground))}.file-name{grid-column:2;grid-row:2;display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-foreground);font-weight:600}.result{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;margin:0;padding:6px 4px 7px 14px;border:0;border-radius:0;background:transparent;color:inherit}.result:hover{background:var(--vscode-list-hoverBackground)}.result-meta{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}.line-number{color:var(--vscode-descriptionForeground)}.score{color:var(--vscode-textLink-foreground);font-weight:400}.copy-status{position:relative;display:inline-flex;width:14px;height:14px;flex:0 0 14px;align-items:center;justify-content:center;border-radius:50%;opacity:0;transform:scale(.65);transition:opacity .12s ease,transform .16s ease;--copy-check-color:#fff}.copy-status::before{content:'';position:absolute;inset:0;border-radius:50%;background:var(--vscode-focusBorder,var(--vscode-textLink-foreground));transform:scale(0);transition:transform .16s ease}.copy-status::after{content:'✓';position:relative;z-index:1;color:var(--copy-check-color);font-size:10px;font-weight:700;line-height:14px;opacity:0;transition:opacity .08s ease .08s}.copy-status.copied{opacity:1;transform:scale(1)}.copy-status.copied::before{transform:scale(1)}.copy-status.copied::after{opacity:1}.snippet{display:-webkit-box;min-width:0;flex:1;margin:0;color:var(--vscode-descriptionForeground);overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal}.more-results{display:block;width:100%;margin:0;padding:2px 4px 7px 14px;text-align:left;background:transparent;color:var(--vscode-descriptionForeground);font-size:16px;line-height:1;border:0;border-radius:0}.more-results:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}.empty{padding:10px 0;color:var(--vscode-descriptionForeground)}.result-summary{margin:8px 4px 0;padding-top:6px;border-top:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size)*.92)}.result-summary:empty{display:none}.idle-mark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden}.idle-mark[hidden]{display:none}.idle-mark svg{width:clamp(112px,42vw,160px);min-width:112px;height:auto;color:var(--vscode-descriptionForeground);opacity:.13;filter:blur(.65px);transform:scale(.98);transition:opacity .18s ease,filter .18s ease}.idle-mark .efs-stroke{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.35}.idle-mark .efs-fill{fill:currentColor}
.history-toggle{flex:0 0 auto;min-width:30px;height:30px;padding:2px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:999px;background:transparent;color:var(--vscode-input-foreground)}
.history-toggle:hover,.history-toggle[aria-expanded="true"]{background:var(--vscode-toolbar-hoverBackground)}
.history-toggle:focus-visible,.history-entry:focus-visible,.history-clear:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.history-panel{max-height:240px;overflow-y:auto;margin:6px 0 2px;padding:2px 0 6px;border-bottom:1px solid var(--vscode-panel-border)}
.history-panel[hidden]{display:none}
.history-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px;color:var(--vscode-descriptionForeground)}
.history-clear{border:0;background:transparent;color:var(--vscode-textLink-foreground)}
.history-entry{display:flex;justify-content:space-between;gap:8px;width:100%;padding:6px 8px;text-align:left;border:0;background:transparent;color:var(--vscode-foreground)}
.history-entry:hover{background:var(--vscode-list-hoverBackground)}
.history-term{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history-mode{flex:0 0 auto;color:var(--vscode-descriptionForeground);font-size:calc(var(--vscode-font-size)*.9)}
.history-empty{padding:8px;color:var(--vscode-descriptionForeground)}
@media(max-width:340px){form{flex-direction:column}.search-input{flex:none;width:100%}.search-mode{align-self:flex-start}}
</style></head><body>
<form id="search"><div class="search-input"><input id="query" type="search" aria-label="Search your workspace" placeholder="${searchPlaceholder}" autocomplete="off"><button id="clear-query" class="clear-button" type="button" aria-label="Clear search" title="Clear search" hidden><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4 4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button><button class="search-button" type="submit" aria-label="Search" title="Search (Enter)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="m10 10 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div><span class="search-mode"><select id="mode" title="Search mode"><option value="hybrid">Hybrid</option><option value="semantic">Semantic</option><option value="exact">Exact</option></select></span><button id="history-toggle" class="history-toggle" type="button" aria-label="Recent searches" aria-controls="history-panel" aria-expanded="false" title="Recent searches">↶</button></form>
<div id="history-panel" class="history-panel" hidden><div class="history-heading"><span>Recent searches</span><button id="history-clear" class="history-clear" type="button">Clear history</button></div><div id="history-list"></div></div>
${actions}
<div class="search-content">
  <div id="status" class="status"></div><div id="answer"></div><div id="results"></div><div id="summary" class="result-summary" aria-live="polite"></div>
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
const vscode=acquireVsCodeApi();const form=document.getElementById('search');const query=document.getElementById('query');const clearQuery=document.getElementById('clear-query');const mode=document.getElementById('mode');const status=document.getElementById('status');const answer=document.getElementById('answer');const results=document.getElementById('results');const summary=document.getElementById('summary');const idle=document.getElementById('idle');const ask=document.getElementById('ask');const historyToggle=document.getElementById('history-toggle');const historyPanel=document.getElementById('history-panel');const historyList=document.getElementById('history-list');const historyClear=document.getElementById('history-clear');
let searchTimer;let requestId=0;let submittedQuery='';let submittedMode='';let composing=false;let copiedIndicator;let searching=false;let queryEditing=false;
const MAX_RESULTS_PER_FILE=7;
const HISTORY_LIMIT=20;const INACTIVITY_MS=8*60*60*1000;
const savedState=vscode.getState?.()||{};
let history=Array.isArray(savedState.history)?savedState.history.filter(item=>item&&typeof item.query==='string'&&['hybrid','semantic','exact'].includes(item.mode)).map(item=>({query:item.query.slice(0,500),mode:item.mode})).slice(0,HISTORY_LIMIT):[];
let lastActivityAt=Number.isFinite(savedState.lastActivityAt)&&savedState.lastActivityAt>0?savedState.lastActivityAt:Date.now();
let inactivityTimer;let historyVisible=false;
function saveHistoryState(){vscode.setState?.({history,lastActivityAt})}
function renderHistory(){historyList.replaceChildren();history.forEach((item,index)=>{const button=document.createElement('button');button.type='button';button.className='history-entry';button.dataset.historyIndex=String(index);button.title=item.query+' ('+item.mode+')';const term=document.createElement('span');term.className='history-term';term.textContent=item.query;const searchMode=document.createElement('span');searchMode.className='history-mode';searchMode.textContent=item.mode;button.append(term,searchMode);historyList.append(button)});if(!history.length){const empty=document.createElement('div');empty.className='history-empty';empty.textContent='No recent searches.';historyList.append(empty)}historyPanel.hidden=!historyVisible;historyToggle.setAttribute('aria-expanded',String(historyVisible))}
function addSearchHistory(term,searchMode){if(!term)return;history=[{query:term.slice(0,500),mode:searchMode},...history.filter(item=>item.query!==term||item.mode!==searchMode)].slice(0,HISTORY_LIMIT);saveHistoryState();renderHistory()}
function scheduleInactivityCheck(){clearTimeout(inactivityTimer);inactivityTimer=setTimeout(checkInactivity,Math.max(1,INACTIVITY_MS-(Date.now()-lastActivityAt)))}
function checkInactivity(){if(Date.now()-lastActivityAt<INACTIVITY_MS){scheduleInactivityCheck();return false}clearTimeout(searchTimer);submittedQuery='';submittedMode=mode.value;query.value='';searching=false;composing=false;historyVisible=false;clearResults();renderHistory();vscode.postMessage({type:'search',query:'',mode:mode.value,requestId:++requestId});lastActivityAt=Date.now();saveHistoryState();scheduleInactivityCheck();return true}
function markActivity(){checkInactivity();lastActivityAt=Date.now();saveHistoryState();scheduleInactivityCheck()}
${groupSearchResults.toString()}
${splitResultPath.toString()}
${formatResultScore.toString()}
function contrastCheckColor(value){const color=String(value||'').trim();let rgb;let match=color.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);if(match){let hex=match[1];if(hex.length===3||hex.length===4)hex=hex.slice(0,3).split('').map(char=>char+char).join('');else hex=hex.slice(0,6);rgb=[parseInt(hex.slice(0,2),16),parseInt(hex.slice(2,4),16),parseInt(hex.slice(4,6),16)]}else{match=color.match(/^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)/i);if(match)rgb=match.slice(1,4).map(Number)}if(!rgb||rgb.some(component=>!Number.isFinite(component)))return '#fff';const linear=component=>{const normalized=Math.max(0,Math.min(255,component))/255;return normalized<=.03928?normalized/12.92:Math.pow((normalized+.055)/1.055,2.4)};const luminance=.2126*linear(rgb[0])+.7152*linear(rgb[1])+.0722*linear(rgb[2]);return luminance>.5?'#000':'#fff'}
function showCopyConfirmation(index){const indicator=results.querySelector('[data-index="'+Number(index)+'"] .copy-status');if(!indicator)return;if(copiedIndicator&&copiedIndicator!==indicator)copiedIndicator.classList.remove('copied');const styles=getComputedStyle(document.documentElement);const accent=styles.getPropertyValue('--vscode-focusBorder').trim()||styles.getPropertyValue('--vscode-textLink-foreground').trim();indicator.style.setProperty('--copy-check-color',contrastCheckColor(accent));indicator.classList.remove('copied');void indicator.offsetWidth;indicator.classList.add('copied');copiedIndicator=indicator}
function updateIdleState(){idle.hidden=Boolean(query.value.trim())&&!searching}
function updateQueryControls(){clearQuery.hidden=!query.value;updateIdleState()}
function clearResults(){answer.textContent='';answer.className='';results.replaceChildren();summary.textContent='';copiedIndicator=undefined;status.textContent='';status.className='status';if(ask)ask.disabled=true;updateQueryControls()}
function search(){clearTimeout(searchTimer);if(composing)return;submittedQuery=query.value.trim();submittedMode=mode.value;searching=Boolean(submittedQuery);if(submittedQuery)addSearchHistory(submittedQuery,submittedMode);clearResults();vscode.postMessage({type:'search',query:submittedQuery,mode:submittedMode,requestId:++requestId})}
function scheduleSearch(){clearTimeout(searchTimer);if(ask)ask.disabled=true;searching=Boolean(query.value.trim());updateQueryControls();if(!query.value.trim()){search();return}if(!composing)searchTimer=setTimeout(search,350)}
form.addEventListener('submit',event=>{event.preventDefault();markActivity();search()});
historyToggle.addEventListener('click',()=>{markActivity();historyVisible=!historyVisible;renderHistory()});
historyClear.addEventListener('click',()=>{markActivity();history=[];saveHistoryState();renderHistory()});
historyList.addEventListener('click',event=>{const button=event.target.closest('[data-history-index]');if(!button)return;const item=history[Number(button.dataset.historyIndex)];if(!item)return;markActivity();query.value=item.query;mode.value=item.mode;historyVisible=false;renderHistory();updateQueryControls();search()});
clearQuery.addEventListener('click',()=>{markActivity();query.value='';updateQueryControls();query.focus();search()});
query.addEventListener('input',()=>{markActivity();scheduleSearch()});
query.addEventListener('compositionstart',()=>{composing=true;clearTimeout(searchTimer)});
query.addEventListener('compositionend',()=>{composing=false;scheduleSearch()});
query.addEventListener('pointerdown',()=>{queryEditing=true});
query.addEventListener('keydown',event=>{const key=String(event.key||'');const pasteShortcut=(event.metaKey||event.ctrlKey)&&key.toLowerCase()==='v';if(!pasteShortcut&&!['Meta','Control','Shift','Alt'].includes(key))queryEditing=true});
query.addEventListener('blur',()=>{queryEditing=false});
window.addEventListener('paste',event=>{if(queryEditing&&event.target===query)return;const text=event.clipboardData?.getData('text');if(typeof text!=='string')return;event.preventDefault();query.value=text;query.focus();query.setSelectionRange?.(query.value.length,query.value.length);scheduleSearch()});
mode.addEventListener('change',()=>{markActivity();search()});
ask?.addEventListener('click',()=>vscode.postMessage({type:'ask'}));
results.addEventListener('click',event=>{const button=event.target.closest('[data-index]');if(button)vscode.postMessage({type:'open',index:Number(button.dataset.index)})});
results.addEventListener('contextmenu',event=>{const button=event.target.closest('[data-index]');if(button){event.preventDefault();vscode.postMessage({type:'copyPath',index:Number(button.dataset.index)})}});
window.addEventListener('pointerdown',markActivity);window.addEventListener('keydown',markActivity);window.addEventListener('wheel',markActivity);
window.addEventListener('focus',checkInactivity);document.addEventListener('visibilitychange',checkInactivity);
window.addEventListener('message',event=>{checkInactivity();const message=event.data;if(message.type==='placeholder'){query.placeholder=String(message.value||'Search your workspace…');return}if(message.requestId!==undefined&&(message.requestId!==requestId||query.value.trim()!==submittedQuery||mode.value!==submittedMode))return;if(message.type==='copied'){showCopyConfirmation(message.index);return}if(message.type==='busy'){if(message.requestId!==undefined){searching=true;updateIdleState()}status.className='status';status.textContent=message.label;return}if(message.type==='error'){if(message.requestId!==undefined){searching=false;updateIdleState()}status.className='error';status.textContent=message.message;return}if(message.type==='answer'){status.className='status';status.textContent='Answer from '+message.model;answer.className='answer';answer.textContent=message.answer;return}if(message.type==='results'){searching=false;updateIdleState();answer.textContent='';answer.className='';status.className=message.warning?'warning':'status';status.textContent=message.warning||'';if(ask)ask.disabled=!message.results.length;results.replaceChildren();const groups=groupSearchResults(message.results);const folderCount=groups.filter(group=>group.entries[0]?.result?.kind==='folder').length;const fileCount=groups.length-folderCount;summary.textContent=message.results.length+' result'+(message.results.length===1?'':'s')+' across '+fileCount+' file'+(fileCount===1?'':'s')+(folderCount?' and '+folderCount+' folder'+(folderCount===1?'':'s'):'');if(!message.results.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching files or folders.';results.append(empty);return}groups.forEach(group=>{const section=document.createElement('section');section.className='file-group';const heading=document.createElement('button');heading.type='button';heading.className='file-heading';heading.dataset.index=String(group.entries[0].index);heading.title=group.relative;heading.setAttribute('aria-label','Open '+group.relative);const pathParts=splitResultPath(group.relative);const tree=document.createElement('span');tree.className='folder-tree';tree.setAttribute('aria-hidden','true');heading.append(tree);if(pathParts.folders.length){const route=document.createElement('span');route.className='folder-route';route.title=pathParts.folders.join('/');pathParts.folders.forEach(folder=>{const segment=document.createElement('span');segment.className='folder-segment';segment.textContent=folder;route.append(segment)});heading.append(route)}const fileName=document.createElement('span');fileName.className='file-name';fileName.textContent=(group.entries[0]?.result?.kind==='folder'?'📁 ':'')+pathParts.filename;heading.append(fileName);section.append(heading);const list=document.createElement('div');list.className='file-results';const appendEntry=entry=>{const result=entry.result;const button=document.createElement('button');button.type='button';button.className='result';button.dataset.index=String(entry.index);const snippet=document.createElement('span');snippet.className='snippet';snippet.textContent=result.text.replace(/\\s+/g,' ');const meta=document.createElement('span');meta.className='result-meta';const line=document.createElement('span');line.className='line-number';line.textContent=String(result.line+1);line.title='Line '+String(result.line+1);const score=document.createElement('span');score.className='score';score.textContent=formatResultScore(result.score);score.title='Relevance '+String(result.score);const copied=document.createElement('span');copied.className='copy-status';copied.setAttribute('aria-hidden','true');if(result.kind!=='folder')meta.append(line);meta.append(score,copied);button.append(snippet,meta);list.append(button)};group.entries.slice(0,MAX_RESULTS_PER_FILE).forEach(appendEntry);section.append(list);if(group.entries.length>MAX_RESULTS_PER_FILE){const more=document.createElement('button');more.type='button';more.className='more-results';more.textContent='…';const remaining=group.entries.length-MAX_RESULTS_PER_FILE;more.title='Show '+remaining+' more result'+(remaining===1?'':'s')+' in '+pathParts.filename;more.setAttribute('aria-label',more.title);more.addEventListener('click',()=>{group.entries.slice(MAX_RESULTS_PER_FILE).forEach(appendEntry);more.remove()});section.append(more)}results.append(section)})}});
updateQueryControls();renderHistory();checkInactivity();
query.focus();
</script></body></html>`;
  }
}

module.exports = { WorkspaceSearchViewProvider, groupSearchResults, splitResultPath, formatResultScore };
