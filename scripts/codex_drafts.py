"""Guarded Codex VS Code new-chat draft isolation; never change authentication."""

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / 'assets/codex'
HOST_START = '\n/* sweetiebot-codex-drafts-host:start */\n'
HOST_END = '\n/* sweetiebot-codex-drafts-host:end */\n'
WEB_START = '/* sweetiebot-codex-drafts-webview:start */\n'
WEB_END = '/* sweetiebot-codex-drafts-webview:end */\n'
HOST_ANCHOR = re.compile(
    r'(?P<vscode>[\w$]+)\.window\.registerWebviewViewProvider\('
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
    matches = list(HOST_ANCHOR.finditer(source))
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
    webviews = [p for p in (root / 'webview/assets').glob('app-initial-*.js')
                if WEB_START in p.read_text() or 'acquireVsCodeApi()' in p.read_text()]
    if len(webviews) != 1:
        if enabled:
            raise ValueError('Unsupported Codex draft webview: ambiguous bootstrap.')
        return []
    paths = [(host, transform_host), (webviews[0], transform_webview)]
    return [(p, p.read_text(), transform(p.read_text(), enabled)) for p, transform in paths]
