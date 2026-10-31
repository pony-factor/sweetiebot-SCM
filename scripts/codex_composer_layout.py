"""Validated drag/drop Codex composer layout preferences and local settings editor."""
import html
import json

IDS = ("input", "attachments", "access", "location", "clipboard", "send")
LABELS = ("Message input", "Attachments", "Access permissions",
          "Computer / location / usage", "Clipboard Send / Queue", "Send / Stop (wing)")
DEFAULT_LAYOUT = {"visible": list(IDS), "hidden": []}
DEFAULT_LAYOUT_JSON = json.dumps(DEFAULT_LAYOUT, separators=(",", ":"))


def parse_layout(value):
    try:
        obj = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError) as error:
        raise ValueError("Invalid Codex composer layout JSON.") from error
    if not isinstance(obj, dict) or set(obj) != {"visible", "hidden"}:
        raise ValueError("Codex composer layout requires visible and hidden zones.")
    visible, hidden = obj["visible"], obj["hidden"]
    if not isinstance(visible, list) or not isinstance(hidden, list):
        raise ValueError("Codex composer zones must be lists.")
    combined = visible + hidden
    if len(combined) != len(IDS) or any(not isinstance(x, str) for x in combined) or set(combined) != set(IDS):
        raise ValueError("Codex composer layout contains missing, duplicate or unknown controls.")
    if "input" not in visible:
        raise ValueError("The Codex input must remain available.")
    return {"visible": visible[:], "hidden": hidden[:]}


def serialize_layout(value):
    return json.dumps(parse_layout(value), separators=(",", ":"))


def render_control(current):
    try:
        layout = parse_layout(current)
    except ValueError:
        layout = parse_layout(DEFAULT_LAYOUT_JSON)

    def item(key):
        label = html.escape(dict(zip(IDS, LABELS))[key])
        return ('<div class="codex-layout-item" draggable="true" tabindex="0" role="listitem" '
                'data-codex-layout-id="' + key + '"><span aria-hidden="true">⋮⋮</span> '
                + label + (' (required)' if key == "input" else "") +
                ' <button type="button" data-codex-layout-toggle title="Move between trays" aria-label="Move ' +
                label + ' between trays">↔</button></div>')

    return ('<section class="codex-layout-editor" aria-label="Codex composer layout">'
            '<input type="hidden" id="codex-composer-layout" name="codexComposerLayout" value="' +
            html.escape(serialize_layout(layout), quote=True) + '">'
            '<div class="codex-layout-head"><strong>Codex composer layout</strong>'
            '<button type="button" id="codex-layout-reset">Reset</button></div>'
            '<small>Drag to reorder, drag out to hide, or select ↔. Hidden controls can be revealed '
            'from More controls in the composer. Input stays accessible.</small>'
            '<label>In composer</label><div id="codex-layout-visible" role="list" '
            'class="codex-layout-zone" data-codex-layout-zone="visible">' +
            "".join(map(item, layout["visible"])) + '</div>'
            '<label>Available controls</label><div id="codex-layout-hidden" role="list" '
            'class="codex-layout-zone" data-codex-layout-zone="hidden">' +
            "".join(map(item, layout["hidden"])) + '</div>'
            '<small>Send and Stop share a position; the existing Pegasus wing toggle controls their appearance.</small>'
            '</section>')


CONFIG_STYLE = """
.codex-layout-editor{margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.codex-layout-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
.codex-layout-editor label{display:block;margin:10px 0 5px;font-size:12px;font-weight:600;color:var(--muted)}
.codex-layout-zone{display:flex;flex-wrap:wrap;gap:6px;min-height:46px;padding:6px;border:1px dashed var(--line);border-radius:7px}
.codex-layout-zone.is-over{border-color:var(--accent)}
.codex-layout-item{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:6px;padding:5px 7px;background:var(--panel);cursor:grab}
.codex-layout-item button{padding:2px 6px}
.codex-layout-item:focus-visible{outline:2px solid var(--accent)}
.codex-layout-item.is-dragging{opacity:.5}
"""

CONFIG_SCRIPT = """
(() => {
  const input = document.getElementById("codex-composer-layout");
  if (!input) return;
  const zones = [...document.querySelectorAll("[data-codex-layout-zone]")];
  const zone = name => zones.find(el => el.dataset.codexLayoutZone === name);
  const items = [...document.querySelectorAll("[data-codex-layout-id]")];
  let dragging = null;
  function sync() {
    const read = name => [...zone(name).children].map(el => el.dataset.codexLayoutId);
    input.value = JSON.stringify({visible:read("visible"), hidden:read("hidden")});
    input.dispatchEvent(new Event("input", {bubbles:true}));
  }
  function move(item, target, before = null) {
    if (item.dataset.codexLayoutId === "input" && target === zone("hidden")) return;
    target.insertBefore(item, before);
    sync();
  }
  for (const item of items) {
    item.addEventListener("dragstart", event => {
      if (event.target.closest?.("button")) {event.preventDefault();return;}
      dragging = item;
      item.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.codexLayoutId);
    });
    item.addEventListener("dragend", () => {
      dragging = null;item.classList.remove("is-dragging");
      zones.forEach(z => z.classList.remove("is-over"));
    });
    item.querySelector("button").addEventListener("click", () =>
      move(item, zone(item.parentElement === zone("visible") ? "hidden" : "visible")));
    item.addEventListener("keydown", event => {
      if (!event.altKey || !["ArrowLeft","ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const sibling = event.key === "ArrowLeft" ? item.previousElementSibling : item.nextElementSibling;
      if (sibling) move(item, item.parentElement, event.key === "ArrowLeft" ? sibling : sibling.nextSibling);
    });
  }
  for (const target of zones) {
    target.addEventListener("dragover", event => {
      if (!dragging || (dragging.dataset.codexLayoutId === "input" && target === zone("hidden"))) return;
      event.preventDefault();event.dataTransfer.dropEffect = "move";target.classList.add("is-over");
    });
    target.addEventListener("dragleave", event => {
      if (!target.contains(event.relatedTarget)) target.classList.remove("is-over");
    });
    target.addEventListener("drop", event => {
      target.classList.remove("is-over");
      if (!dragging) return;
      event.preventDefault();
      const near = event.target.closest?.("[data-codex-layout-id]");
      let before = null;
      if (near && near !== dragging && near.parentElement === target) {
        const box = near.getBoundingClientRect();
        before = event.clientX < box.left + box.width / 2 ? near : near.nextSibling;
      }
      move(dragging, target, before);
    });
  }
  document.getElementById("codex-layout-reset").addEventListener("click", () => {
    const byId = new Map(items.map(item => [item.dataset.codexLayoutId, item]));
    ["input","attachments","access","location","clipboard","send"].forEach(id =>
      zone("visible").append(byId.get(id)));
    sync();
  });
})();
"""
