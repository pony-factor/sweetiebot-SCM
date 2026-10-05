"""Guarded, reversible capture of file drops throughout the Codex webview."""

import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets/codex"
START = '\n/* scm-toolkit-codex-image-drop:start */\n'
END = '\n/* scm-toolkit-codex-image-drop:end */\n'


def transform(source, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex image-drop patch.')
    if START in source:
        before, remainder = source.split(START, 1)
        payload, after = remainder.split(END, 1)
        metadata = re.search(r'^/\* edit:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex image-drop restoration metadata is missing.')
        original, replacement = json.loads(metadata.group(1))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed Codex image-drop patch changed.')
        source = source.replace(replacement, original, 1)
    if remove or not re.search(r'addEventListener\([`\"\']dragenter[`\"\']', source):
        return source
    ident = r'[A-Za-z_$][\w$]*'
    quote = r'''[`"']'''
    capture = r'(?:!0|true)'
    pattern = re.compile(
        rf'if\((?P<root>{ident})!=null\)return '
        rf'(?P=root)\.addEventListener\({quote}dragenter{quote},(?P<enter>{ident}),{capture}\),'
        rf'(?P=root)\.addEventListener\({quote}dragover{quote},(?P=enter),{capture}\),'
        rf'(?P=root)\.addEventListener\({quote}dragleave{quote},(?P<leave>{ident}),{capture}\),'
        rf'(?P=root)\.addEventListener\({quote}drop{quote},(?P<drop>{ident}),{capture}\),'
        rf'\(\)=>\{{(?P=root)\.removeEventListener\({quote}dragenter{quote},(?P=enter),{capture}\),'
        rf'(?P=root)\.removeEventListener\({quote}dragover{quote},(?P=enter),{capture}\),'
        rf'(?P=root)\.removeEventListener\({quote}dragleave{quote},(?P=leave),{capture}\),'
        rf'(?P=root)\.removeEventListener\({quote}drop{quote},(?P=drop),{capture}\)\}}'
    )
    matches = list(pattern.finditer(source))
    if not matches:
        if 'dragCounterRef:' in source:
            raise ValueError('Unsupported Codex build: image-drop listeners do not match.')
        return source
    if len(matches) != 1:
        raise ValueError('Unsupported Codex build: image-drop listeners are ambiguous.')
    match = matches[0]
    original = match.group(0)
    replacement = ('return scmToolkitRegisterImageDropTarget('
                   + ','.join(match[name] for name in ('root', 'enter', 'leave', 'drop')) + ')')
    source = source.replace(original, replacement, 1)
    return (source + START + '/* edit:' + json.dumps([original, replacement]) + ' */\n'
            + (ASSETS / 'codex-image-drop.js').read_text() + END)
