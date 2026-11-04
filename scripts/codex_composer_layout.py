"""Validated left/right/hidden Codex composer layout and drag-and-drop settings UI."""
import html
import json

IDS = ("input", "attachments", "access", "location", "clipboard", "send")
LABELS = ("Message input", "Attachments", "Access permissions",
          "Computer / location / usage", "Clipboard Send / Queue", "Send / Stop (wing)")
ICONS = {"input": "✎", "attachments": "⌁", "access": "♙",
         "location": "◎", "clipboard": "▤", "send": "➤"}
DEFAULT_LAYOUT = {"left": list(IDS[:-1]), "right": ["send"], "hidden": []}
DEFAULT_LAYOUT_JSON = json.dumps(DEFAULT_LAYOUT, separators=(",", ":"))


def parse_layout(value):
    try:
        obj = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError) as error:
        raise ValueError("Invalid Codex composer layout JSON.") from error
    if not isinstance(obj, dict):
        raise ValueError("Codex composer layout must contain zones.")
    # Existing saved visible/hidden preferences remain valid. Place Send on
    # the right by default without discarding any other custom ordering.
    if set(obj) == {"visible", "hidden"}:
        visible, hidden = obj["visible"], obj["hidden"]
        if not isinstance(visible, list) or not isinstance(hidden, list):
            raise ValueError("Codex composer zones must be lists.")
        if "input" not in visible:
            raise ValueError("The Codex input must remain available.")
        obj = {
            "left": ["input"] + [item for item in visible if item not in ("input", "send")],
            "right": ["send"] if "send" in visible else [],
            "hidden": hidden,
        }
    if set(obj) != {"left", "right", "hidden"}:
        raise ValueError("Codex composer layout requires left, right and hidden zones.")
    zones = [obj[name] for name in ("left", "right", "hidden")]
    if any(not isinstance(zone, list) for zone in zones):
        raise ValueError("Codex composer zones must be lists.")
    combined = sum(zones, [])
    if (len(combined) != len(IDS) or any(not isinstance(item, str) for item in combined)
            or set(combined) != set(IDS)):
        raise ValueError("Codex composer layout contains missing, duplicate or unknown controls.")
    if "input" not in obj["left"]:
        raise ValueError("The Codex input must remain left aligned and available.")
    return {name: obj[name][:] for name in ("left", "right", "hidden")}


def serialize_layout(value):
    return json.dumps(parse_layout(value), separators=(",", ":"))


def render_control(current):
    try:
        layout = parse_layout(current)
    except ValueError:
        layout = parse_layout(DEFAULT_LAYOUT_JSON)

    def item(key):
        label = html.escape(dict(zip(IDS, LABELS))[key], quote=True)
        title = label + (" (required)" if key == "input" else "")
        toggle = ("" if key == "input" else
                  '<button type="button" data-codex-layout-toggle title="Change alignment of ' +
                  label + '" aria-label="Change alignment of ' + label + '">↔</button>')
        return ('<div class="codex-layout-item" draggable="true" tabindex="0" role="listitem" '
                'data-codex-layout-id="' + key + '" title="' + title +
                '" aria-label="' + title + '">'
                '<span class="codex-layout-grip" aria-hidden="true">⋮⋮</span>'
                '<span class="codex-layout-icon" aria-hidden="true">' + ICONS[key] + '</span>' +
                toggle + '</div>')

    return ('<section class="codex-layout-editor" aria-label="Codex composer layout">'
            '<input type="hidden" id="codex-composer-layout" name="codexComposerLayout" value="' +
            html.escape(serialize_layout(layout), quote=True) + '">'
            '<div class="codex-layout-head"><strong>Codex composer layout</strong>'
            '<button type="button" id="codex-layout-reset">Reset</button></div>'
            '<small>Drag icons between left, right and hidden. The insertion bar follows your pointer; '
            'hover for control names and action tooltips. Message input stays on the left.</small>'
            '<div class="codex-layout-rail" aria-label="Composer toolbar preview">'
            '<div class="codex-layout-side codex-layout-side-left">'
            '<span class="codex-layout-caption">Left aligned</span>'
            '<div id="codex-layout-left" role="list" class="codex-layout-zone" '
            'data-codex-layout-zone="left">' + "".join(map(item, layout["left"])) + '</div></div>'
            '<div class="codex-layout-side codex-layout-side-right">'
            '<span class="codex-layout-caption">Right aligned</span>'
            '<div id="codex-layout-right" role="list" class="codex-layout-zone" '
            'data-codex-layout-zone="right">' + "".join(map(item, layout["right"])) + '</div></div></div>'
            '<label>Hidden controls (available in More controls)</label>'
            '<div id="codex-layout-hidden" role="list" class="codex-layout-zone codex-layout-hidden" '
            'data-codex-layout-zone="hidden">' + "".join(map(item, layout["hidden"])) + '</div>'
            '<small>Use ↔ to cycle alignment or Alt+arrow keys to reorder; '
            'Send and Stop share the Pegasus wing position.</small>'
            '</section>')


CONFIG_STYLE = """
.codex-layout-editor{margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.codex-layout-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.codex-layout-editor label{display:block;margin:10px 0 5px;font-size:12px;font-weight:600;color:var(--muted)}
.codex-layout-rail{display:flex;align-items:stretch;gap:8px;margin-top:10px;padding:6px;border:1px dashed var(--line);border-radius:8px}
.codex-layout-side{display:flex;flex-direction:column;gap:5px;min-width:0}
.codex-layout-side-left{flex:1 1 auto}
.codex-layout-side-right{flex:0 1 auto;min-width:94px}
.codex-layout-caption{font-size:11px;font-weight:600;color:var(--muted)}
.codex-layout-side-right .codex-layout-caption{text-align:right}
.codex-layout-zone{display:flex;flex-wrap:wrap;align-content:flex-start;gap:5px;min-height:38px;padding:4px;border:1px dashed transparent;border-radius:6px;transition:border-color .12s,background .12s}
.codex-layout-side-right .codex-layout-zone{justify-content:flex-end}
.codex-layout-hidden{border-color:var(--line);min-height:44px}
.codex-layout-zone.is-over{border-color:var(--accent);background:var(--panel)}
.codex-layout-item{display:inline-flex;align-items:center;gap:4px;height:32px;padding:3px 5px;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:grab;user-select:none;transition:transform .12s,opacity .12s}
.codex-layout-grip{color:var(--muted);font-size:12px;letter-spacing:-3px;cursor:grab}
.codex-layout-icon{display:inline-flex;align-items:center;justify-content:center;min-width:17px;font-size:16px}
.codex-layout-item button{padding:2px 5px;min-width:22px;cursor:pointer}
.codex-layout-item:focus-visible,.codex-layout-item button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.codex-layout-item.is-dragging{opacity:.2;cursor:grabbing}
.codex-layout-drop-marker{display:block;align-self:stretch;width:3px;min-height:30px;margin:0 2px;border-radius:4px;background:var(--accent);box-shadow:0 0 0 2px var(--bg);pointer-events:none}
@media(max-width:540px){.codex-layout-rail{gap:4px}.codex-layout-side-right{min-width:72px}}
"""

CONFIG_SCRIPT = """
(() => {
  const input = document.getElementById("codex-composer-layout");
  if (!input) return;
  const names = ["left", "right", "hidden"];
  const zone = name => document.querySelector('[data-codex-layout-zone="' + name + '"]');
  const zones = names.map(zone);
  const items = [...document.querySelectorAll("[data-codex-layout-id]")];
  const marker = document.createElement("span");
  marker.className = "codex-layout-drop-marker";
  marker.setAttribute("aria-hidden", "true");
  let dragging = null;

  function sync() {
    const read = name => [...zone(name).children]
      .filter(el => el.dataset.codexLayoutId).map(el => el.dataset.codexLayoutId);
    input.value = JSON.stringify({left:read("left"),right:read("right"),hidden:read("hidden")});
    input.dispatchEvent(new Event("input", {bubbles:true}));
  }
  function updateActions() {
    for (const item of items) {
      const button = item.querySelector("[data-codex-layout-toggle]");
      if (!button) continue;
      const location = item.parentElement.dataset.codexLayoutZone;
      const next = names[(names.indexOf(location) + 1) % names.length];
      const label = item.getAttribute("aria-label");
      const action = next === "hidden" ? "Hide" : "Move to " + next + " aligned:";
      button.title = action + " " + label;
      button.setAttribute("aria-label", button.title);
    }
  }
  function move(item, target, before = null) {
    if (!target || (item.dataset.codexLayoutId === "input" && target !== zone("left"))) return;
    target.insertBefore(item, before);
    updateActions();
    sync();
  }
  function clearDrop() {
    marker.remove();
    zones.forEach(target => target.classList.remove("is-over"));
  }
  // Match a pointer to the nearest insertion boundary, including wrapped rows.
  // Exclude the dragged item so the insertion marker does not jump around it.
  function beforeAt(target, event) {
    const peers = [...target.children].filter(el =>
      el.dataset.codexLayoutId && el !== dragging);
    for (const peer of peers) {
      const rect = peer.getBoundingClientRect();
      if (event.clientY < rect.top ||
          (event.clientY <= rect.bottom && event.clientX < rect.left + rect.width / 2)) {
        return peer;
      }
    }
    return null;
  }
  for (const item of items) {
    item.addEventListener("dragstart", event => {
      if (event.target.closest?.("button")) {event.preventDefault(); return;}
      dragging = item;
      item.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.codexLayoutId);
    });
    item.addEventListener("dragend", () => {
      dragging = null;
      item.classList.remove("is-dragging");
      clearDrop();
    });
    const button = item.querySelector("[data-codex-layout-toggle]");
    button?.addEventListener("click", () => {
      const current = item.parentElement.dataset.codexLayoutZone;
      move(item, zone(names[(names.indexOf(current) + 1) % names.length]));
    });
    item.addEventListener("keydown", event => {
      if (!event.altKey || !["ArrowLeft","ArrowRight","ArrowDown","ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      if (event.shiftKey || event.key === "ArrowDown" || event.key === "ArrowUp") {
        const current = item.parentElement.dataset.codexLayoutZone;
        const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = names[(names.indexOf(current) + delta + names.length) % names.length];
        move(item, zone(next));
      } else {
        const sibling = event.key === "ArrowLeft" ? item.previousElementSibling : item.nextElementSibling;
        if (sibling) move(item, item.parentElement,
          event.key === "ArrowLeft" ? sibling : sibling.nextElementSibling);
      }
    });
  }
  for (const target of zones) {
    target.addEventListener("dragover", event => {
      if (!dragging || (dragging.dataset.codexLayoutId === "input" && target !== zone("left"))) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      zones.forEach(el => el.classList.toggle("is-over", el === target));
      const before = beforeAt(target, event);
      if (marker.parentElement !== target || marker.nextElementSibling !== before)
        target.insertBefore(marker, before);
    });
    target.addEventListener("drop", event => {
      if (!dragging || marker.parentElement !== target) return;
      event.preventDefault();
      const item = dragging;
      move(item, target, marker);
      clearDrop();
    });
  }
  document.getElementById("codex-layout-reset").addEventListener("click", () => {
    const byId = new Map(items.map(item => [item.dataset.codexLayoutId, item]));
    ["input","attachments","access","location","clipboard"].forEach(id =>
      zone("left").append(byId.get(id)));
    zone("right").append(byId.get("send"));
    clearDrop();
    updateActions();
    sync();
  });
  updateActions();
})();
"""
