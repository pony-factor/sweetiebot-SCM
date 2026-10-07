"""Drag-and-drop settings UI for the SCM message bar."""

from __future__ import annotations

import html
import json

from message_bar import (
    DEFAULT_MESSAGE_BAR_LAYOUT,
    DEFAULT_MESSAGE_BAR_LAYOUT_JSON,
    MESSAGE_BAR_ITEMS,
    parse_message_bar_layout,
)


def _item_html(item_id: str, label: str) -> str:
    classes = "message-bar-item"
    if item_id.startswith("separator-"):
        classes += " message-bar-separator"
    escaped_id = html.escape(item_id, quote=True)
    escaped_label = html.escape(label)
    remove = (
        f'<button type="button" class="message-bar-remove" aria-label="Remove {escaped_label}" '
        f'title="Remove {escaped_label}">×</button>'
        if item_id.startswith("separator-") else ""
    )
    return (
        f'<div class="{classes}" draggable="true" tabindex="0" '
        f'data-message-bar-id="{escaped_id}" role="button" '
        f'aria-label="Drag {escaped_label}" title="Drag {escaped_label}">'
        '<span class="message-bar-grip" aria-hidden="true">⋮⋮</span>'
        f'<span>{escaped_label}</span>{remove}</div>'
    )


def render_message_bar_control(current: object) -> str:
    try:
        layout = parse_message_bar_layout(current)
    except ValueError:
        layout = {zone: list(items) for zone, items in DEFAULT_MESSAGE_BAR_LAYOUT.items()}

    labels = dict(MESSAGE_BAR_ITEMS)
    active = set(layout["before"] + layout["after"])
    hidden = [item_id for item_id, _label in MESSAGE_BAR_ITEMS if item_id not in active]

    def render(items: list[str]) -> str:
        return "".join(_item_html(item_id, labels.get(item_id, "Separator " + item_id.removeprefix("separator-"))) for item_id in items)

    serialized = html.escape(json.dumps(layout, separators=(",", ":")), quote=True)
    default_serialized = html.escape(DEFAULT_MESSAGE_BAR_LAYOUT_JSON, quote=True)
    return (
        '<div class="message-bar-setting">'
        f'<input type="hidden" id="message-bar-layout" name="messageBarLayout" value="{serialized}" '
        f'data-message-bar-default="{default_serialized}">'
        '<p class="message-bar-help">Drag the buttons and separators into the order you want. Add as many separators as you need. '
        'The message field and commit-and-push checkbox stay fixed.</p>'
        '<button type="button" id="message-bar-add-separator">Add separator</button>'
        '<div class="message-bar-preview">'
        '<section class="message-bar-tray"><span>Before message</span>'
        f'<div class="message-bar-zone" data-message-bar-zone="before">{render(layout["before"])}</div>'
        '</section>'
        '<div class="message-bar-fixed"><strong>Message</strong>'
        '<small>Message field + fixed push checkbox</small></div>'
        '<section class="message-bar-tray"><span>After message</span>'
        f'<div class="message-bar-zone" data-message-bar-zone="after">{render(layout["after"])}</div>'
        '</section></div>'
        '<section class="message-bar-hidden"><div class="message-bar-hidden-head">'
        '<span><strong>Hidden controls</strong><small>Drop controls here to remove them from the message bar.</small></span>'
        '<button type="button" id="message-bar-reset">Reset layout</button></div>'
        f'<div class="message-bar-zone message-bar-hidden-zone" data-message-bar-zone="hidden">{render(hidden)}</div>'
        '</section></div>'
    )


MESSAGE_BAR_STYLE = r"""
.message-bar-setting{padding:10px 0 4px;border-top:1px solid var(--line)}
#message-bar-add-separator{margin-bottom:12px}
.message-bar-remove{padding:0 4px;border:0;font-size:18px;line-height:1;cursor:pointer}
.message-bar-help{margin:0 0 14px;color:var(--muted)}
.message-bar-preview{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}
.message-bar-tray,.message-bar-hidden{min-width:0;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.message-bar-tray{display:grid;grid-template-columns:125px minmax(0,1fr);gap:10px;align-items:center}
.message-bar-tray>span{color:var(--muted);font-size:12px;font-weight:600}
.message-bar-zone{display:flex;align-content:flex-start;gap:6px;min-height:48px;padding:6px;border:1px dashed #484f58;border-radius:7px;flex-wrap:wrap}
.message-bar-zone.is-over{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--bg))}
.message-bar-item{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:grab;user-select:none;white-space:nowrap}
.message-bar-item:active{cursor:grabbing}
.message-bar-item:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.message-bar-item.is-dragging{opacity:.45}
.message-bar-grip{color:var(--muted);letter-spacing:-2px}
.message-bar-separator{border-style:dashed}
.message-bar-separator::after{content:"";display:block;width:1px;height:18px;margin-left:2px;background:var(--muted)}
.message-bar-fixed{display:flex;justify-content:flex-start;align-items:center;gap:10px;min-height:48px;padding:10px;border:1px solid var(--accent);border-radius:9px;background:color-mix(in srgb,var(--accent) 8%,var(--panel));text-align:center}
.message-bar-fixed strong{width:125px;flex:none;text-align:left}.message-bar-fixed small{margin:0;font-size:11px}
.message-bar-hidden{margin-top:10px}
.message-bar-hidden-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.message-bar-hidden-head>span{min-width:0}.message-bar-hidden-head small{margin:2px 0 0}
.message-bar-hidden-zone{min-height:46px}
@media(max-width:460px){.message-bar-tray{grid-template-columns:1fr}.message-bar-fixed{flex-wrap:wrap}.message-bar-fixed strong{width:auto}}
"""


MESSAGE_BAR_SCRIPT = r"""
const messageBarLayoutInput = document.getElementById('message-bar-layout');
const messageBarZones = [...document.querySelectorAll('[data-message-bar-zone]')];
let messageBarItems = [...document.querySelectorAll('[data-message-bar-id]')];
let draggedMessageBarItem = null;

function messageBarZone(name) {
  return messageBarZones.find(zone => zone.dataset.messageBarZone === name);
}

function syncMessageBarLayout() {
  if (!messageBarLayoutInput) return;
  const readZone = name => [...messageBarZone(name).querySelectorAll(':scope > [data-message-bar-id]')]
    .map(item => item.dataset.messageBarId);
  messageBarLayoutInput.value = JSON.stringify({
    before: readZone('before'),
    after: readZone('after')
  });
  messageBarLayoutInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function placeMessageBarItem(zone, item, event) {
  const target = event?.target?.closest?.('[data-message-bar-id]');
  if (!target || target === item || target.parentElement !== zone) {
    zone.append(item);
    return;
  }
  const box = target.getBoundingClientRect();
  const horizontal = Math.abs(event.clientY - (box.top + box.height / 2)) < box.height / 2;
  const before = horizontal
    ? event.clientX < box.left + box.width / 2
    : event.clientY < box.top + box.height / 2;
  zone.insertBefore(item, before ? target : target.nextSibling);
}

function bindMessageBarItem(item) {
    item.addEventListener('dragstart', event => {
      if (event.target.closest?.('button')) { event.preventDefault(); return; }
      draggedMessageBarItem = item;
      item.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.dataset.messageBarId);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      draggedMessageBarItem = null;
      for (const zone of messageBarZones) zone.classList.remove('is-over');
    });
    item.querySelector('.message-bar-remove')?.addEventListener('click', () => {
      item.remove();
      messageBarItems = messageBarItems.filter(candidate => candidate !== item);
      syncMessageBarLayout();
    });
}

function createMessageBarSeparator(number) {
  const item = document.createElement('div');
  item.className = 'message-bar-item message-bar-separator';
  item.draggable = true;
  item.tabIndex = 0;
  item.dataset.messageBarId = `separator-${number}`;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-label', `Drag Separator ${number}`);
  item.title = `Drag Separator ${number}`;
  item.innerHTML = `<span class="message-bar-grip" aria-hidden="true">⋮⋮</span><span>Separator ${number}</span><button type="button" class="message-bar-remove" aria-label="Remove Separator ${number}" title="Remove Separator ${number}">×</button>`;
  messageBarItems.push(item);
  bindMessageBarItem(item);
  return item;
}

if (messageBarLayoutInput) {
  for (const item of messageBarItems) bindMessageBarItem(item);
  document.getElementById('message-bar-add-separator')?.addEventListener('click', () => {
    const used = new Set(messageBarItems.map(item => item.dataset.messageBarId));
    let number = 1;
    while (used.has(`separator-${number}`)) number += 1;
    const item = createMessageBarSeparator(number);
    messageBarZone('after').append(item);
    syncMessageBarLayout();
  });

  for (const zone of messageBarZones) {
    zone.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', event => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-over');
    });
    zone.addEventListener('drop', event => {
      event.preventDefault();
      zone.classList.remove('is-over');
      const id = draggedMessageBarItem?.dataset.messageBarId || event.dataTransfer.getData('text/plain');
      const item = messageBarItems.find(candidate => candidate.dataset.messageBarId === id);
      if (!item) return;
      placeMessageBarItem(zone, item, event);
      syncMessageBarLayout();
    });
  }

  document.getElementById('message-bar-reset')?.addEventListener('click', () => {
    const layout = JSON.parse(messageBarLayoutInput.dataset.messageBarDefault);
    const defaultIds = new Set([...layout.before, ...layout.after]);
    for (const item of [...messageBarItems]) {
      if (item.dataset.messageBarId.startsWith('separator-') && !defaultIds.has(item.dataset.messageBarId)) {
        item.remove();
        messageBarItems = messageBarItems.filter(candidate => candidate !== item);
      }
    }
    for (const id of ['separator-1', 'separator-2']) {
      if (!messageBarItems.some(item => item.dataset.messageBarId === id)) {
        const number = id.slice('separator-'.length);
        createMessageBarSeparator(number);
      }
    }
    const byId = new Map(messageBarItems.map(item => [item.dataset.messageBarId, item]));
    for (const zoneName of ['before', 'after']) {
      const zone = messageBarZone(zoneName);
      for (const id of layout[zoneName]) zone.append(byId.get(id));
    }
    const active = new Set([...layout.before, ...layout.after]);
    const hidden = messageBarZone('hidden');
    for (const item of messageBarItems) {
      if (!active.has(item.dataset.messageBarId)) hidden.append(item);
    }
    syncMessageBarLayout();
  });
}
"""
