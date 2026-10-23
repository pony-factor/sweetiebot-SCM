"""Drag-and-drop heading editor for the Window settings page."""
import html

TOKENS = ["rootName", "activeRepositoryBranchName", "activeEditorShort",
          "activeEditorMedium", "separator", "appName", "profileName",
          "folderName", "focusedView", "remoteName", "dirty", "activeEditorState"]

def render_heading(value):
    escaped = html.escape(str(value or ""), quote=True)
    choices = "".join('<button type="button" draggable="true" data-title-token="' + name + '">' + name + '</button>' for name in TOKENS)
    return (
        '<div class="heading-editor"><strong>Title-bar heading</strong>'
        '<small>Drag placeholders to reorder your heading, or type a custom template. '
        'Leave blank to follow window.title.</small>'
        '<div class="heading-controls"><button type="button" id="heading-add-text">Add text</button>'
        '<button type="button" id="heading-example">Example</button>'
        '<button type="button" id="heading-clear">Follow VS Code</button></div>'
        '<div id="heading-layout"></div>'
        '<label class="heading-source">Template<input id="heading-raw" value="' + escaped + '" '
        'placeholder="VS Code window.title" autocomplete="off"></label>'
        '<input type="hidden" id="heading-value" name="windowHeading" value="' + escaped + '">'
        '<small>Available placeholders: click or drag to add. Drag a selected placeholder back here to remove.</small>'
        '<div id="heading-available">' + choices + '</div></div>'
    )

WINDOW_TITLE_STYLE = """
.heading-editor{padding:12px 0;border-top:1px solid var(--line)}
.heading-controls{display:flex;gap:8px;margin:12px 0}
#heading-layout,#heading-available{display:flex;flex-wrap:wrap;gap:6px;min-height:45px;padding:10px;border:1px dashed var(--line);border-radius:7px;background:var(--bg)}
#heading-layout.over,#heading-available.over{border-color:var(--accent)}
.heading-chip,#heading-available button{padding:7px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);cursor:grab}
.heading-chip:focus-visible{outline:2px solid var(--accent)}
.heading-chip button{padding:0 4px;border:0}
.heading-chip.dragging{opacity:.5}
.heading-source{display:flex;flex-direction:column;gap:4px;margin:12px 0;font-size:12px}
.heading-source input{padding:8px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--text);font:12px ui-monospace,monospace}
"""

WINDOW_TITLE_SCRIPT = r"""
const headingLayout = document.getElementById('heading-layout');
if (headingLayout) {
  const available = document.getElementById('heading-available');
  const raw = document.getElementById('heading-raw');
  const stored = document.getElementById('heading-value');
  const tokenText = token => '$' + '{' + token + '}';
  const tokenPattern = new RegExp(String.fromCharCode(92) + '$' + String.fromCharCode(92) + '{[a-zA-Z][a-zA-Z0-9_]*' + String.fromCharCode(92) + '}', 'g');
  let dragging = null;
  function serialize() {
    stored.value = [...headingLayout.children].map(el =>
      el.dataset.token ? tokenText(el.dataset.token) : el.querySelector('input').value).join('');
    raw.value = stored.value;
    stored.dispatchEvent(new Event('input', {bubbles: true}));
  }
  function chip(part) {
    const el = document.createElement('span');
    el.className = 'heading-chip';
    el.draggable = true;
    el.tabIndex = 0;
    if (part.token) {
      el.dataset.token = part.token;
      const title = document.createElement('span');
      title.textContent = part.token;
      el.append(title);
    } else {
      const field = document.createElement('input');
      field.type = 'text';
      field.value = part.text;
      field.placeholder = 'Text';
      field.setAttribute('aria-label','Custom title text');
      field.addEventListener('input',serialize);
      el.append(field);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove element';
    remove.setAttribute('aria-label','Remove title element');
    remove.addEventListener('click',()=>{el.remove();serialize();});
    el.append(remove);
    el.addEventListener('dragstart',event=>{
      if (event.target.closest?.('input,button')) { event.preventDefault(); return; }
      dragging = {el};
      el.classList.add('dragging');
      event.dataTransfer.setData('text/plain','title-part');
    });
    el.addEventListener('dragend',()=>{el.classList.remove('dragging');dragging=null;});
    el.addEventListener('keydown',event=>{
      if (event.target!==el || !event.altKey) return;
      if (event.key==='ArrowLeft' && el.previousElementSibling) headingLayout.insertBefore(el,el.previousElementSibling);
      else if (event.key==='ArrowRight' && el.nextElementSibling) headingLayout.insertBefore(el.nextElementSibling,el);
      else return;
      event.preventDefault();serialize();el.focus();
    });
    return el;
  }
  function render(value) {
    const parts = [];
    let index = 0;
    for (const match of value.matchAll(tokenPattern)) {
      if (match.index>index) parts.push({text:value.slice(index,match.index)});
      parts.push({token:match[0].slice(2,-1)});
      index=match.index+match[0].length;
    }
    if (index<value.length) parts.push({text:value.slice(index)});
    headingLayout.replaceChildren(...parts.map(chip));
    stored.value=value;raw.value=value;
  }
  for (const button of available.querySelectorAll('[data-title-token]')) {
    button.addEventListener('click',()=>{headingLayout.append(chip({token:button.dataset.titleToken}));serialize();});
    button.addEventListener('dragstart',event=>{
      dragging={token:button.dataset.titleToken};
      event.dataTransfer.setData('text/plain',tokenText(button.dataset.titleToken));
    });
    button.addEventListener('dragend',()=>{dragging=null;});
  }
  for (const target of [headingLayout,available]) {
    target.addEventListener('dragover',event=>{
      if (!dragging) return;
      event.preventDefault();target.classList.add('over');
    });
    target.addEventListener('dragleave',event=>{if(!target.contains(event.relatedTarget))target.classList.remove('over');});
    target.addEventListener('drop',event=>{
      if (!dragging) return;
      event.preventDefault();target.classList.remove('over');
      if (target===available) dragging.el?.remove();
      else {
        const el=dragging.el||chip({token:dragging.token});
        const anchor=event.target.closest?.('.heading-chip');
        if (anchor && anchor!==el && anchor.parentElement===headingLayout) {
          const box=anchor.getBoundingClientRect();
          headingLayout.insertBefore(el,event.clientX<box.left+box.width/2?anchor:anchor.nextSibling);
        } else headingLayout.append(el);
      }
      serialize();
    });
  }
  document.getElementById('heading-add-text').addEventListener('click',()=>{
    const el=chip({text:''}); headingLayout.append(el); el.querySelector('input').focus(); serialize();
  });
  document.getElementById('heading-example').addEventListener('click',()=>{
    render(tokenText('rootName')+' ('+tokenText('activeRepositoryBranchName')+')');serialize();
  });
  document.getElementById('heading-clear').addEventListener('click',()=>{render('');serialize();});
  raw.addEventListener('input',()=>{render(raw.value);stored.dispatchEvent(new Event('input',{bubbles:true}));});
  window.refreshHeadingEditor=next=>{
    if(!document.querySelector('.heading-editor').matches(':focus-within')&&next!==stored.value)render(next);
  };
  render(stored.value);
}
"""
