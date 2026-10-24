"""Guarded patches for window-local Codex snapshots and explicit thread handoff."""

import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets/codex"
START = '\n/* scm-toolkit-codex-context:start */\n'
END = '\n/* scm-toolkit-codex-context:end */\n'
HOST_ANCHOR = re.compile(
    r'(?P<subscriptions>[\w$]+)\.push\((?P<vscode>[\w$]+)\.window\.registerWebviewViewProvider\('
    r'(?P<type>[\w$]+)\.viewType,(?P<provider>[\w$]+),'
)
WEBVIEW_ANCHOR = re.compile(r'(?P<api>[\w$]+)=acquireVsCodeApi\(\)')


def transform(source, kind, enabled=True):
    import codex_drafts
    had_drafts = kind == 'host' and codex_drafts.HOST_START in source
    if had_drafts:
        source = codex_drafts.transform_host(source, False)
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex context patch; refusing to overwrite it.')
    if START in source:
        before, remainder = source.split(START, 1)
        payload, after = remainder.split(END, 1)
        metadata = re.search(r'^/\* edit:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex context patch is missing restoration metadata.')
        original, replacement = json.loads(metadata.group(1))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed Codex context patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if not enabled:
        return codex_drafts.transform_host(source) if had_drafts else source
    pattern = HOST_ANCHOR if kind == 'host' else WEBVIEW_ANCHOR
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError(f'Unsupported Codex build: {kind} context anchor is ambiguous or missing.')
    match = matches[0]
    original = match.group(0)
    if kind == 'host':
        replacement = original.replace('.push(',
            f'.push(scmToolkitRegisterCodexSnapshotProvider({match["provider"]},{match["vscode"]}),'
            f'scmToolkitRegisterCodexWorkspaceHandoff({match["provider"]},{match["vscode"]}),', 1)
    else:
        replacement = f'({original},scmToolkitRegisterCodexSnapshot({match["api"]}))'
    source = source.replace(original, replacement, 1)
    helper = (ASSETS / f'context-{kind}.js').read_text()
    if kind == 'host':
        helper += '\n' + (ASSETS / 'workspace-handoff-host.js').read_text()
    result = (source + START + '/* edit:' + json.dumps([original, replacement]) + ' */\n'
              + helper + END)
    return codex_drafts.transform_host(result) if had_drafts else result


def patch_files(extension_path=None, enabled=True):
    candidates = ([Path(extension_path)] if extension_path is not None else
                  sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True))
    if not candidates:
        if enabled:
            raise ValueError('The Codex extension is not installed.')
        return []
    extension = candidates[0]
    host = extension / 'out/extension.js'
    if not host.is_file():
        if enabled:
            raise ValueError('The Codex extension host bundle was not found.')
        return []
    webviews = []
    for path in (extension / 'webview/assets').glob('*.js'):
        text = path.read_text()
        if START in text or WEBVIEW_ANCHOR.search(text):
            webviews.append(path)
    if len(webviews) != 1:
        if enabled:
            raise ValueError('The Codex webview API bundle could not be identified.')
        return []
    results = []
    for path, kind in [(host, 'host'), (webviews[0], 'webview')]:
        old = path.read_text()
        results.append((path, old, transform(old, kind, enabled)))
    return results
