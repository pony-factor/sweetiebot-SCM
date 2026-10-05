"""Guarded, reversible Codex host patch for macOS idle-sleep prevention."""

import json
from pathlib import Path
import re

START = '\n/* scm-toolkit-codex-keep-awake:start */\n'
END = '\n/* scm-toolkit-codex-keep-awake:end */\n'
ANCHOR = re.compile(
    r'(?P<subscriptions>[\w$]+)\.push\((?P<connection>[\w$]+)\.registerInternalNotificationHandler\('
    r'[\w$]+=>\{[\w$]+\.method===\"turn/completed\"&&[\w$]+\.invalidateGitReadCachesForTurn\('
)
VSCODE = re.compile(r'(?P<vscode>[\w$]+)\.window\.registerUriHandler\(')
ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/codex-keep-awake.js'


def transform(source, enabled=True, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex keep-awake patch; refusing to overwrite it.')
    if START in source:
        before, remainder = source.split(START, 1)
        payload, after = remainder.split(END, 1)
        metadata = re.search(r'^/\* edit:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex keep-awake patch is missing restoration metadata.')
        original, replacement = json.loads(metadata.group(1))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed Codex keep-awake patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    matches = list(ANCHOR.finditer(source))
    vscode = set(match['vscode'] for match in VSCODE.finditer(source))
    if len(matches) != 1 or len(vscode) != 1:
        raise ValueError('Unsupported Codex build: keep-awake activity anchor is ambiguous or missing.')
    match = matches[0]
    original = match.group(0)
    replacement = original.replace('.push(',
        f'.push(scmToolkitRegisterCodexKeepAwake({match["connection"]},{next(iter(vscode))},{str(enabled).lower()}),', 1)
    return (source.replace(original, replacement, 1) + START
            + '/* edit:' + json.dumps([original, replacement]) + ' */\n' + ASSET.read_text() + END)


def patch_file(extension_path=None, enabled=True, remove=False):
    candidates = ([Path(extension_path)] if extension_path is not None else
                  sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True))
    if not candidates:
        return None
    path = candidates[0] / 'out/extension.js'
    if not path.is_file():
        return None
    old = path.read_text()
    return path, old, transform(old, enabled, remove)
