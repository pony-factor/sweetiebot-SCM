"""Reversible GitHub PR reaction-hover augmentation for the installed extension."""

import json
from pathlib import Path

WEBVIEW_START = '\n/* sweetiebot-pr-reactions:start */\n'
WEBVIEW_END = '\n/* sweetiebot-pr-reactions:end */\n'
CSP_START = '\n/* sweetiebot-pr-reactions-csp:start */\n'
CSP_END = '\n/* sweetiebot-pr-reactions-csp:end */\n'
CSP_ANCHOR = 'img-src vscode-resource: https:; media-src https:; script-src'
CSP_REPLACEMENT = ('img-src vscode-resource: https:; '
                   'connect-src https://api.github.com; media-src https:; script-src')
ASSET = Path(__file__).resolve().parent.parent / 'assets/github/pr_reaction_hover.js'


def transform_webview(source, remove=False):
    """Append one DOM-only tooltip script after the upstream React bundle."""
    if source.count(WEBVIEW_START) != source.count(WEBVIEW_END) or source.count(WEBVIEW_START) > 1:
        raise ValueError('Incomplete GitHub PR reaction hover patch.')
    if WEBVIEW_START in source:
        before, remainder = source.split(WEBVIEW_START, 1)
        installed, after = remainder.split(WEBVIEW_END, 1)
        if installed != ASSET.read_text():
            raise ValueError('Installed GitHub PR reaction hover patch changed; refusing to remove it.')
        source = before + after
    if remove:
        return source
    if 'comment-reactions' not in source:
        raise ValueError('Unsupported GitHub PR reaction webview: missing reaction anchor.')
    return source + WEBVIEW_START + ASSET.read_text() + WEBVIEW_END


def transform_csp(source, remove=False):
    """Allow only GitHub's public user profile endpoint for tooltip display names."""
    if source.count(CSP_START) != source.count(CSP_END) or source.count(CSP_START) > 1:
        raise ValueError('Incomplete GitHub PR reaction CSP patch.')
    if CSP_START in source:
        before, remainder = source.split(CSP_START, 1)
        edit, after = remainder.split(CSP_END, 1)
        original, replacement = json.loads(edit.removeprefix('/* edit:').removesuffix(' */'))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed GitHub PR reaction CSP changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    if source.count(CSP_ANCHOR) != 1:
        raise ValueError('Unsupported GitHub PR host: expected one overview CSP anchor.')
    result = source.replace(CSP_ANCHOR, CSP_REPLACEMENT, 1)
    return result + CSP_START + '/* edit:' + json.dumps([CSP_ANCHOR, CSP_REPLACEMENT]) + ' */' + CSP_END
