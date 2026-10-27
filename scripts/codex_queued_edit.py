"""Reversible native queue adapters; optional UI code is isolated from module loading."""

import json
from pathlib import Path
import re

from codex_composer import runtime_payload

ASSETS = Path(__file__).resolve().parent.parent / 'assets/codex'
START = '\n/* sweetiebot-codex-queued-edit:start */\n'
END = '\n/* sweetiebot-codex-queued-edit:end */\n'
IDENT = r'[A-Za-z_$][\w$]*'


def transform(source, kind, enabled=True):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex queued-edit patch.')
    if START in source:
        before, rest = source.split(START, 1)
        payload, after = rest.split(END, 1)
        metadata = re.search(r'^/\* edits:(.*?) \*/$', payload, re.M)
        if metadata is None:
            raise ValueError('Codex queued-edit restoration metadata is missing.')
        source = before + after
        for original, replacement in reversed(json.loads(metadata[1])):
            if source.count(replacement) != 1:
                raise ValueError('Installed Codex queued-edit patch changed.')
            source = source.replace(replacement, original, 1)
    if not enabled:
        return source
    edits = []
    if kind == 'store':
        declarations = list(re.finditer(rf'function ({IDENT})\(([^)]*)\)\{{', source))
        candidates = []
        for index, match in enumerate(declarations):
            end = declarations[index + 1].start() if index + 1 < len(declarations) else len(source)
            body = source[match.start():end]
            if 'visibleMessages:' in body and 'getTurnCoordinator()' in body and 'actions:' in body:
                candidates.append((match, body))
        if len(candidates) != 1:
            raise ValueError('Unsupported Codex queue store adapter.')
        declaration, body = candidates[0]
        manager = re.search(rf'({IDENT})\(({IDENT}),({IDENT})\)\.getTurnCoordinator\(\)', body)
        result = re.search(rf',({IDENT})\}}(?:async\s*)?$', body)
        if manager is None or result is None:
            raise ValueError('Unsupported Codex queue store capabilities.')
        original = body[result.start():result.start() + len(result[1]) + 1]
        replacement = (',scmToolkitRegisterQueueStore(' + declaration[2] + ',' + manager[3] + ','
                       + result[1] + ',()=>'+manager[1]+'('+manager[2]+','+manager[3]+').getTurnCoordinator())')
        # Restrict replacement to the selected native hook's return expression.
        offset = declaration.start() + result.start()
        source = source[:offset] + replacement + source[offset + len(original):]
        edits.append([original, replacement])
    elif kind == 'rows':
        props = re.search(rf'\{{messageId:({IDENT}),position:{IDENT},fullMessageText:{IDENT},.*?hostId:({IDENT}),isEditing:', source)
        refs = list(re.finditer(rf'ref:({IDENT}),style:({IDENT}),initial:!1,animate:', source))
        preview = list(re.finditer(rf'"aria-label":{IDENT}\.formatMessage\(\{{id:`composer\.queuedMessage\.preview\.trigger\.label`', source))
        if props is None or len(refs) != 1 or len(preview) != 1:
            raise ValueError('Unsupported Codex queued-message row adapter.')
        original = refs[0][0]
        replacement = original.replace('ref:'+refs[0][1], 'ref:scmToolkitQueueRowRef('+refs[0][1]+','+props[1]+','+props[2]+')', 1)
        edits.append([original, replacement])
        edits.append([preview[0][0], '"data-scm-toolkit-queue-preview":!0,' + preview[0][0]])
        for original, replacement in edits:
            if source.count(original) != 1:
                raise ValueError('Ambiguous Codex queued-message adapter.')
            source = source.replace(original, replacement, 1)
    else:
        raise ValueError('Unknown Codex queued-edit adapter kind.')
    helper = (ASSETS / 'queued-edit-bridge.js').read_text()
    if kind == 'rows':
        helper += runtime_payload('queued-message editing', (ASSETS / 'queued-edit.js').read_text())
    return source + START + '/* edits:' + json.dumps(edits) + ' */\n' + helper + END


def patch_files(extension_path=None, enabled=True):
    candidates = ([Path(extension_path)] if extension_path is not None else
                  sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True))
    if not candidates:
        return []
    found = {'store': [], 'rows': []}
    for path in (candidates[0] / 'webview/assets').glob('*.js'):
        source = path.read_text()
        if 'beginEdit:' in source and 'restoreEdit:' in source and 'visibleMessages:' in source and '.getTurnCoordinator()' in source:
            found['store'].append((path, source))
        elif 'composer.queuedMessage.preview.trigger.label' in source and 'defaultMessage:' in source:
            found['rows'].append((path, source))
        elif START in source:
            kind = 'store' if 'scmToolkitRegisterQueueStore(' in source.split(START, 1)[0] else 'rows'
            found[kind].append((path, source))
    if enabled and any(len(paths) != 1 for paths in found.values()):
        raise ValueError('Unsupported Codex queue editing: native capabilities were not identified uniquely.')
    return [(path, old, transform(old, kind, enabled))
            for kind, paths in found.items() for path, old in paths]
