'use strict';

const crypto = require('node:crypto');

const VIEW_ID = 'scmToolkit.ponyInfo';
const CONTEXT_KEY = 'scmToolkit.hasPonyProfile';
const STATE_KEY = 'scmToolkit.ponyProfile';

function displayName(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}


function normalizeImageIndex(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const candidate = typeof item === 'string' ? { url: item } : item;
    const url = String(candidate?.url || '').trim();
    if (!/^https:\/\//i.test(url)) return [];
    const image = { url };
    const label = String(candidate?.label || '').trim();
    const kind = String(candidate?.kind || '').trim();
    if (label) image.label = label;
    if (kind) image.kind = kind;
    return [image];
  });
}

function normalizePonyProfile(value) {
  if (!value || typeof value !== 'object') return undefined;
  const slug = String(value.slug || '').trim();
  if (!slug) return undefined;
  const profile = {
    slug,
    name: String(value.name || displayName(slug)).trim() || displayName(slug),
    packId: String(value.packId || '').trim(),
    packLabel: String(value.packLabel || '').trim(),
    packDescription: String(value.packDescription || '').trim(),
  };
  const source = String(value.source || '').trim();
  if (/^https:\/\//i.test(source)) profile.source = source;
  const images = normalizeImageIndex(value.images);
  if (images.length) profile.images = images;
  return profile;
}

class PonyProfileViewProvider {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
    this.view = undefined;
    this.profile = normalizePonyProfile(context.workspaceState.get(STATE_KEY));
  }

  async initialize() {
    await this.vscode.commands.executeCommand('setContext', CONTEXT_KEY, Boolean(this.profile));
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => void this.onMessage(message));
  }

  async setProfile(value) {
    this.profile = normalizePonyProfile(value);
    await this.context.workspaceState.update(STATE_KEY, this.profile);
    await this.vscode.commands.executeCommand('setContext', CONTEXT_KEY, Boolean(this.profile));
    this.post();
    return this.profile;
  }

  post() {
    this.view?.webview.postMessage({ type: 'profile', profile: this.profile || null });
  }

  async onMessage(message) {
    if (message?.type === 'ready') {
      this.post();
      return;
    }
    if (message?.type === 'clear') {
      await this.setProfile(undefined);
      return;
    }
    if (message?.type === 'openSource' && this.profile?.source) {
      await this.vscode.env.openExternal(this.vscode.Uri.parse(this.profile.source));
      return;
    }
    if (message?.type === 'openImage') {
      const index = Number(message.index);
      const image = Number.isInteger(index) && index >= 0 ? this.profile?.images?.[index] : undefined;
      if (image?.url) await this.vscode.env.openExternal(this.vscode.Uri.parse(image.url));
    }
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{box-sizing:border-box;margin:0;padding:10px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family)}
.card{display:flex;flex-direction:column;gap:8px}.section-title{font-size:.92em;font-weight:700}.image-list{display:flex;flex-direction:column;gap:6px}.image-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--vscode-widget-border)}.image-copy{min-width:0;flex:1}.image-label{font-weight:600}.image-kind{margin-top:1px;color:var(--vscode-descriptionForeground);font-size:.88em}.title-row{display:flex;align-items:flex-start;gap:8px}.identity{min-width:0;flex:1}.name{font-size:1.1em;font-weight:700;line-height:1.25}.pack{margin-top:2px;color:var(--vscode-descriptionForeground);font-size:.92em}.description{line-height:1.4;color:var(--vscode-descriptionForeground)}.local-note{padding:7px 8px;border-left:2px solid var(--vscode-textLink-foreground);background:var(--vscode-textBlockQuote-background);line-height:1.35}.actions{display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;border:1px solid var(--vscode-button-border,var(--vscode-widget-border));border-radius:3px;padding:4px 7px;background:transparent;color:var(--vscode-foreground);cursor:pointer}button:hover{background:var(--vscode-toolbar-hoverBackground)}button.primary{border:0;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.primary:hover{background:var(--vscode-button-hoverBackground)}.empty{color:var(--vscode-descriptionForeground)}
</style></head><body>
<div id="root" class="empty">No pony branch is active for PR creation.</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const root=document.getElementById('root');
function render(profile){root.replaceChildren();if(!profile){root.className='empty';root.textContent='No pony branch is active for PR creation.';return}root.className='card';
const titleRow=document.createElement('div');titleRow.className='title-row';const identity=document.createElement('div');identity.className='identity';
const name=document.createElement('div');name.className='name';name.textContent=profile.name||profile.slug;identity.append(name);
if(profile.packLabel){const pack=document.createElement('div');pack.className='pack';pack.textContent=profile.packLabel;identity.append(pack)}titleRow.append(identity);root.append(titleRow);
if(profile.packDescription){const description=document.createElement('div');description.className='description';description.textContent=profile.packDescription;root.append(description)}
if(Array.isArray(profile.images)&&profile.images.length){const heading=document.createElement('div');heading.className='section-title';heading.textContent='Image index ('+profile.images.length+')';root.append(heading);const list=document.createElement('div');list.className='image-list';profile.images.forEach((image,index)=>{const row=document.createElement('div');row.className='image-row';const copy=document.createElement('div');copy.className='image-copy';const label=document.createElement('div');label.className='image-label';label.textContent=image.label||('Image '+(index+1));copy.append(label);if(image.kind){const kind=document.createElement('div');kind.className='image-kind';kind.textContent=image.kind;copy.append(kind)}const open=document.createElement('button');open.type='button';open.textContent='Open';open.addEventListener('click',()=>vscode.postMessage({type:'openImage',index}));row.append(copy,open);list.append(row)});root.append(list)}
const note=document.createElement('div');note.className='local-note';note.textContent='Local only — this never goes into the pull request. Kafania can add the richer naming, appearance, speaking-role, and image profile in the PR chat.';root.append(note);
const actions=document.createElement('div');actions.className='actions';if(profile.source){const source=document.createElement('button');source.type='button';source.className='primary';source.textContent='Open character source';source.addEventListener('click',()=>vscode.postMessage({type:'openSource'}));actions.append(source)}
const clear=document.createElement('button');clear.type='button';clear.textContent='Dismiss';clear.addEventListener('click',()=>vscode.postMessage({type:'clear'}));actions.append(clear);root.append(actions)}
window.addEventListener('message',event=>{if(event.data?.type==='profile')render(event.data.profile)});vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}

module.exports = {
  CONTEXT_KEY,
  PonyProfileViewProvider,
  STATE_KEY,
  VIEW_ID,
  displayName,
  normalizeImageIndex,
  normalizePonyProfile,
};
