"""Install independent UI customizations without touching Codex host code."""
import json
from pathlib import Path
from html.parser import HTMLParser

import codex_colors
import codex_label
import codex_composer
import codex_queued_edit
import codex_usage
import workspace_search

LABEL_START = '\n/* sweetiebot-ui-window-label:start */\n'
LABEL_END = '\n/* sweetiebot-ui-window-label:end */\n'


class ModuleScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.names = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'module':
            src = (attrs.get('src') or '').split('?', 1)[0]
            if src.startswith('./assets/'):
                name = src.removeprefix('./assets/')
                if Path(name).name == name and name.endswith('.js'):
                    self.names.append(name)


def window_label(source, label):
    if source.count(LABEL_START) != source.count(LABEL_END) or source.count(LABEL_START) > 1:
        raise ValueError('Incomplete UI window-label patch.')
    if LABEL_START in source:
        before, rest = source.split(LABEL_START, 1)
        _, after = rest.split(LABEL_END, 1)
        source = before + after
    if label == 'Codex':
        return source
    label = codex_label._validate_label(label)
    payload = (codex_composer.ASSET.parent / 'window-label.js').read_text().replace(
        '__SCM_TOOLKIT_CODEX_WINDOW_LABEL__', json.dumps(label))
    return source + LABEL_START + codex_composer.runtime_payload('window label', payload) + LABEL_END


def plan(extension, settings, companion=None):
    extension = Path(extension)
    patches = {}

    def add(path, transform):
        path = Path(path)
        old, current = patches.get(path, (path.read_text() if path.exists() else None, None))
        if current is None:
            current = old
        patches[path] = (old, transform(current))

    add(extension / 'package.json', lambda old: codex_label.transform(old, settings['codexWindowLabel']))
    css_path = codex_colors.stylesheet_path(extension)
    if css_path is None:
        raise ValueError('The Codex stylesheet could not be identified.')
    add(css_path, lambda old: codex_colors.transform(old, settings))
    index = extension / 'webview/index.html'
    add(index, lambda old: codex_colors.webview_appearance(old, patches[css_path][1]))
    modules = ModuleScripts()
    modules.feed(index.read_text())
    if len(set(modules.names)) != 1:
        raise ValueError('The native Codex module entry could not be identified uniquely.')
    add(css_path.parent / modules.names[0], lambda old: window_label(old, settings['codexWindowLabel']))
    usage_options = dict(
        enabled=(settings.get('codexUsagePieIndicator', True) or settings.get('codexUsageResetCountdown', False)
                 or settings.get('codexHideUsageResetTimes', False) or settings.get('codexResetTimePieIndicator', False)
                 or not settings.get('codexCloudTasks', False)),
        pie_indicator=settings.get('codexUsagePieIndicator', True),
        reset_countdown=settings.get('codexUsageResetCountdown', False),
        hide_reset_times=settings.get('codexHideUsageResetTimes', False),
        reset_time_pie=settings.get('codexResetTimePieIndicator', False),
        cloud_tasks=settings.get('codexCloudTasks', False))
    for path, _, _ in codex_usage.patch_files(extension, **usage_options):
        add(path, lambda old: codex_usage.transform(old, **usage_options))
    for path, _, _ in codex_composer.patch_files(extension, inline=settings['codexInlineLocation'], paste_button=settings['codexClipboardSubmit']):
        def composer(old, path=path):
            updated = codex_composer.transform_layout(old, settings['codexInlineLocation'], settings['codexClipboardSubmit'],
                codex_composer.clipboard_module(path) if settings['codexClipboardSubmit'] else None)
            if 'id:`composer.placeholder.localFollowUp.locally`' in updated or codex_composer.PLACEHOLDER_START in updated:
                updated = codex_composer.transform_placeholders(updated, settings)
            return updated
        add(path, composer)
    try:
        queue = codex_queued_edit.patch_files(extension, enabled=settings.get('codexInlineQueuedEditing', True))
    except ValueError as error:
        if not str(error).startswith('Unsupported Codex '):
            raise
        print(f'Warning: {error} Native queue controls remain available.')
        queue = []
    for path, old, _ in queue:
        kind = 'store' if 'visibleMessages:' in old else 'rows'
        add(path, lambda old, kind=kind: codex_queued_edit.transform(old, kind, settings.get('codexInlineQueuedEditing', True)))
    companion = Path(companion) if companion is not None else workspace_search.extension_destination()
    if (companion / 'package.json').is_file():
        add(companion / 'package.json', lambda old: workspace_search.transform_view_manifest(old, settings))
        add(companion / 'media/efs.svg', lambda _: (workspace_search.SOURCE / 'media/efs.svg').read_text())
    return [(path, old, new) for path, (old, new) in patches.items() if old != new]


def apply(patches):
    for path, old, _ in patches:
        if (path.read_text() if path.exists() else None) != old:
            raise RuntimeError('Installed UI changed during validation; retry.')
    written = []
    try:
        for path, old, new in patches:
            path.parent.mkdir(parents=True, exist_ok=True)
            written.append((path, old))
            path.write_text(new)
    except OSError:
        for path, old in reversed(written):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(old)
        raise
