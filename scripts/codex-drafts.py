"""Guarded Codex VS Code new-chat draft isolation; never change authentication."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break


import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / 'assets/codex'
HOST_START = '\n/* sweetiebot-codex-drafts-host:start */\n'
HOST_END = '\n/* sweetiebot-codex-drafts-host:end */\n'
WEB_START = '/* sweetiebot-codex-drafts-webview:start */\n'
WEB_END = '/* sweetiebot-codex-drafts-webview:end */\n'
ATTACH_START = '\n/* sweetiebot-codex-attachments:start */\n'
ATTACH_END = '\n/* sweetiebot-codex-attachments:end */\n'
HOST_ANCHOR = re.compile(
    r'(?<![\w$])(?P<vscode>[\w$]+)\.window\.registerWebviewViewProvider\('
    r'(?P<view>[\w$]+)\.viewType,(?P<provider>[\w$]+),'
)


def transform_host(source, enabled=True):
    if source.count(HOST_START) != source.count(HOST_END) or source.count(HOST_START) > 1:
        raise ValueError('Incomplete Codex draft host patch.')
    if HOST_START in source:
        before, rest = source.split(HOST_START, 1)
        metadata, after = rest.split(HOST_END, 1)
        matches = re.findall(r'/\* edit:(.*?) \*/', metadata)
        if len(matches) != 1:
            raise ValueError('Codex draft host patch is missing restoration metadata.')
        original, replacement = json.loads(matches[0])
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed Codex draft host patch changed.')
        source = source.replace(replacement, original, 1)
    if not enabled:
        return source
    # Context restoration metadata contains copies of its registration anchor.
    # Only the executable vendor bundle owns the actual provider registration.
    bundle = source.split('\n/* scm-toolkit-codex-context:start */\n', 1)[0]
    matches = list(HOST_ANCHOR.finditer(bundle))
    if len(matches) != 1:
        raise ValueError('Unsupported Codex webview provider registration.')
    match = matches[0]
    original = match.group()
    replacement = original.replace(
        ',' + match['provider'] + ',',
        ',scmToolkitProtectCodexDrafts(' + match['provider'] + ',' + match['vscode'] + '),', 1)
    return (source.replace(original, replacement, 1) + HOST_START +
            '/* edit:' + json.dumps([original, replacement]) + ' */\n' +
            (ASSETS / 'drafts-host.js').read_text() + HOST_END)


def transform_webview(source, enabled=True):
    if source.count(WEB_START) != source.count(WEB_END) or source.count(WEB_START) > 1:
        raise ValueError('Incomplete Codex draft webview patch.')
    if source.startswith(WEB_START):
        _, remaining = source.split(WEB_END, 1)
        source = remaining
    elif WEB_START in source or WEB_END in source:
        raise ValueError('Misplaced Codex draft webview patch.')
    if not enabled:
        return source
    if not re.search(r'acquireVsCodeApi\(\)', source):
        raise ValueError('Unsupported Codex webview draft bootstrap.')
    return WEB_START + (ASSETS / 'drafts-webview.js').read_text() + '\n' + WEB_END + source


def patch_files(extension_path, enabled=True):
    root = Path(extension_path) if extension_path is not None else None
    if root is None:
        candidates = sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True)
        if not candidates:
            return []
        root = candidates[0]
    host = root / 'out/extension.js'
    if not host.is_file():
        return []
    webviews = [p for p in (root / 'webview/assets').glob('*.js')
                if WEB_START in p.read_text() or 'acquireVsCodeApi()' in p.read_text()]
    if len(webviews) != 1:
        if enabled:
            raise ValueError('Unsupported Codex draft webview: ambiguous bootstrap.')
        return []
    paths = [(host, transform_host), (webviews[0], transform_webview)]
    composers = list((root / 'webview/assets').glob('composer-view-state-*.js'))
    if len(composers) > 1:
        raise ValueError('Unsupported Codex attachment composer: ambiguous state module.')
    if composers:
        paths.append((composers[0], transform_attachments))
    return [(p, p.read_text(), transform(p.read_text(), enabled)) for p, transform in paths]


def transform_attachments(source, enabled=True):
    if source.count(ATTACH_START) != source.count(ATTACH_END) or source.count(ATTACH_START) > 1:
        raise ValueError('Incomplete Codex attachment patch.')
    if ATTACH_START in source:
        source, rest = source.split(ATTACH_START, 1)
        metadata, after = rest.split(ATTACH_END, 1)
        edits = re.findall(r'/\* edits:(.*?) \*/', metadata)
        if len(edits) != 1:
            raise ValueError('Codex attachment patch is missing restoration metadata.')
        source += after
        for original, replacement in reversed(json.loads(edits[0])):
            if source.count(replacement) != 1:
                raise ValueError('Installed Codex attachment patch changed.')
            source = source.replace(replacement, original, 1)
    if not enabled:
        return source
    # These anchors identify the native persisted-signal API, composer key,
    # view-state initializer and attachment mutation boundary. Fail closed if
    # a vendor update changes the contract instead of installing a partial fix.
    signal = re.search(r'([\w$]+)=([\w$]+)\(`composer-auto-context-enabled`,!0\)', source)
    initial = re.search(r'([\w$]+)=([\w$]+)\(([\w$]+),\(\{scope:([\w$]+)\}\)=>\4\.get\(([\w$]+)\)\?\.viewState,', source)
    save = re.search(r'([\w$]+)\.set\((' + re.escape(initial[1]) +
                     r'),([\w$]+)\)\}\}function ([\w$]+)\(', source) if initial else None
    home = re.search(r'([\w$]+)\.imageAttachments=([\w$]+)\(([\w$]+)\)\?\.viewState\.imageAttachments\?\?([\w$]+)\.images', source)
    key = re.search(r'([\w$]+)\(([\w$]+)\.value\),\{images:([\w$]+)\.imageAttachments,attachmentOrder:', source)
    if not all((signal, initial, save, home, key)) or save[2] != initial[1]:
        raise ValueError('Unsupported Codex attachment composer state.')
    edits = [
        (signal[0], signal[0] + ',scmToolkitComposerAttachmentDrafts=' + signal[2] +
         '(`sweetiebot-composer-attachments-v1`,{})'),
        (initial[0], initial[0].replace('?.viewState,', '?.viewState??scmToolkitRestoreComposerAttachments(' +
         initial[4] + ',scmToolkitComposerAttachmentDrafts,' + key[1] + '),')),
        (save[1] + '.set(' + save[2] + ',' + save[3] + ')}}function ' + save[4],
         save[1] + '.set(' + save[2] + ',' + save[3] + ');scmToolkitSaveComposerAttachments(' +
         save[1] + ',' + save[3] + ',scmToolkitComposerAttachmentDrafts,' + key[1] + ')}}function ' + save[4]),
        (home[0], home[0].replace('??' + home[4] + '.images',
         '??(' + home[1] + '.imageAttachments.length?' + home[1] + '.imageAttachments:' + home[4] + '.images)')),
    ]
    for original, replacement in edits:
        if source.count(original) != 1:
            raise ValueError('Unsupported Codex attachment composer anchor.')
        source = source.replace(original, replacement, 1)
    return (source + ATTACH_START + '/* edits:' + json.dumps(edits) + ' */\n' +
            (ASSETS / 'composer-attachments.js').read_text() + ATTACH_END)
