"""Reversible native composer placement and placeholder overrides."""
import json
import re
from pathlib import Path

START = '\n/* scm-toolkit-codex-composer:start */\n'
END = '\n/* scm-toolkit-codex-composer:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/codex-composer-controls.js'


def transform(source, placeholder='', remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex composer patch.')
    if START in source:
        before, rest = source.split(START, 1)
        payload, after = rest.split(END, 1)
        source = before + after
        metadata = re.search(r'^/\* edits:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex composer patch is missing edit metadata.')
        for original, replacement in reversed(json.loads(metadata[1])):
            if source.count(replacement) != 1:
                raise ValueError('Installed Codex composer patch changed.')
            source = source.replace(replacement, original, 1)
    if remove or 'composer.placeholder.localFollowUp.locally' not in source:
        return source
    edits = []
    if placeholder:
        matches = list(re.finditer(r'function [\w$]+\(\{intl:[^}]+\}\)\{return ([\w$]+)\?\?', source))
        matches = [match for match in matches if 'integratedVoiceModeActive:' in match[0] and 'composerKind:' in match[0]]
        if len(matches) != 1:
            raise ValueError('Unsupported Codex build: composer placeholder anchor does not match.')
        original = matches[0][0]
        replacement = original[:original.index('{return ') + 8] + json.dumps(str(placeholder)) + '??' + matches[0][1] + '??'
        edits.append((original, replacement))
        source = source.replace(original, replacement, 1)
    return source + START + '/* edits:' + json.dumps(edits) + ' */\n' + ASSET.read_text() + END


def patch_files(extension_path=None, placeholder='', remove=False):
    candidates = [Path(extension_path)] if extension_path else sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True)
    for candidate in candidates:
        for path in (candidate / 'webview/assets').glob('app-initial-*.js'):
            original = path.read_text()
            if START in original or ('composer.placeholder.localFollowUp.locally' in original and 'integratedVoiceModeActive:' in original):
                yield path, original, transform(original, placeholder, remove)
