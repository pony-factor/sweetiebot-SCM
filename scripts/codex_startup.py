"""Retry one timed-out Codex renderer without duplicating host listeners."""

import json
import re
from pathlib import Path

START = '\n/* sweetiebot-codex-startup:start */\n'
END = '\n/* sweetiebot-codex-startup:end */\n'
ANCHOR = re.compile(
    r'let (?P<watchdog>[\w$]+)=new [\w$]+\((?P<event>[\w$]+)=>\{'
    r'(?=this\.logger\.error\("Webview renderer did not become ready")'
)
CONTENT = re.compile(r'(?P<webview>[\w$]+)\.html=await this\.getWebviewContent\((?P=webview)\)')


def transform(source, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex startup patch; refusing to overwrite it.')
    if START in source:
        before, rest = source.split(START, 1)
        metadata, after = rest.split(END, 1)
        original, replacement = json.loads(metadata.removeprefix('/* edit:').removesuffix(' */'))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Codex startup patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    anchors, contents = list(ANCHOR.finditer(source)), list(CONTENT.finditer(source))
    if len(anchors) != 1 or len(contents) != 1:
        raise ValueError('Unsupported Codex build: startup watchdog anchor is ambiguous or missing.')
    match = anchors[0]
    watchdog, webview = match['watchdog'], contents[0]['webview']
    original = match.group()
    replacement = original.replace('let ', 'let sweetiebotStartupRetried=false;let ', 1)
    replacement = replacement.replace(f'({match["event"]}=>{{', f'(async {match["event"]}=>{{')
    replacement += (
        'if(!sweetiebotStartupRetried){sweetiebotStartupRetried=true;try{'
        f'const sweetiebotHtml=await this.getWebviewContent({webview});'
        f'if(!{watchdog}.disposed){{{webview}.html="";{webview}.html=sweetiebotHtml;{watchdog}.start();}}'
        'return;}catch{'
        f'if({watchdog}.disposed)return;'
        '}}'
    )
    return (source.replace(original, replacement, 1) + START
            + '/* edit:' + json.dumps([original, replacement]) + ' */' + END)


def patch_file(extension_path=None, remove=False):
    candidates = ([Path(extension_path)] if extension_path else
                  sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True))
    if not candidates:
        return None
    path = candidates[0] / 'out/extension.js'
    if not path.is_file():
        return None
    old = path.read_text()
    try:
        return path, old, transform(old, remove)
    except ValueError:
        if START in old:
            raise
        if not remove:
            print('Warning: unsupported Codex startup watchdog; skipping optional recovery.')
        return None
