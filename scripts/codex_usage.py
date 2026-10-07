"""Reversible composer usage labels and reset countdowns."""

import json
import re
from pathlib import Path

START = '\n/* scm-toolkit-codex-usage:start */\n'
END = '\n/* scm-toolkit-codex-usage:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/codex/codex-usage.js'
IDENTIFIER = r'[A-Za-z_$][\w$]*'


def transform(js, enabled=True, hide_reset_times=False, pie_indicator=False, reset_countdown=True):
    if js.count(START) != js.count(END) or js.count(START) > 1:
        raise ValueError('Incomplete Codex usage patch; refusing to overwrite it.')
    if START in js:
        before, rest = js.split(START, 1)
        payload, after = rest.split(END, 1)
        metadata = re.search(r'^/\* edits:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex usage patch is missing edit metadata.')
        js = before + after
        for original, replacement in reversed(json.loads(metadata[1])):
            if js.count(replacement) != 1:
                raise ValueError('Codex usage patch changed; refusing to remove unrelated edits.')
            js = js.replace(replacement, original, 1)
    if not enabled:
        return js

    functions = list(re.finditer(rf'function ({IDENTIFIER})\(', js))
    label = None
    for index, match in enumerate(functions[:-1]):
        body = js[match.start():functions[index + 1].start()]
        if 'id:`composer.mode.local`' in body and 'rateLimit:' in body:
            label = (match[1], body)
            break
    if label is None:
        raise ValueError('Unsupported Codex build: composer usage label anchor does not match.')
    jsx = re.search(rf'\(0,({IDENTIFIER})\.jsx\)', label[1])
    query = re.search(rf'\{{data:({IDENTIFIER})\}}=({IDENTIFIER})\(({IDENTIFIER})\),'
                      rf'({IDENTIFIER})=\1===void 0\?null:\1,({IDENTIFIER})=\4\?\.plan_type', js)
    if jsx is None or query is None:
        raise ValueError('Unsupported Codex build: composer usage data anchor does not match.')
    usage_label = (
        f'(0,{jsx[1]}.jsx)(`scm-toolkit-usage-pie`,{{percent}})'
        if pie_indicator else '`${percent}%`'
    )
    replacement = (
        f'function {label[0]}(e){{let{{data:usage,refetch}}={query[2]}({query[3]}),'
        'percent=scmToolkitRemainingUsage(usage);'
        'scmToolkitKeepUsageFresh(refetch);'
        f'return e.isRemoteHost?`Remote`:percent==null?`…`:{usage_label};}}'
    )
    edits = [(label[1], replacement)]
    home = re.search(
        rf'className:`hidden in-data-\[composer-placement=home\]:inline`,'
        rf'children:\(0,({IDENTIFIER})\.jsx\)\(({IDENTIFIER}),\{{\.\.\.({IDENTIFIER})\.localShort\}}\)', js)
    if home is None:
        raise ValueError('Unsupported Codex build: home composer usage label anchor does not match.')
    edits.append((home[0],
                  f'className:`hidden in-data-[composer-placement=home]:inline`,'
                  f'children:(0,{home[1]}.jsx)({label[0]},{{isRemoteHost:!1}})'))
    if reset_countdown or hide_reset_times:
        reset = re.search(rf'({IDENTIFIER})=({IDENTIFIER})==null\?null:({IDENTIFIER})\(\2\),'
                          rf'({IDENTIFIER})\[0\]=({IDENTIFIER})\.resetsAt', js)
        if reset is None:
            raise ValueError('Unsupported Codex build: composer reset anchor does not match.')
        segment = js[reset.start():reset.start() + 4500]
        original = reset[0]
        if hide_reset_times:
            replacement = f'{reset[1]}=null,{reset[4]}[0]={reset[5]}.resetsAt'
            edits.append((original, replacement))
        else:
            bucket_jsx = re.search(rf'\(0,({IDENTIFIER})\.jsx\)', segment)
            if bucket_jsx is None:
                raise ValueError('Unsupported Codex build: composer reset JSX anchor does not match.')
            replacement = (
                f'{reset[1]}={reset[2]}==null?null:(0,{bucket_jsx[1]}.jsx)('
                '`scm-toolkit-menu-reset`,{'
                f'"reset-at":{reset[5]}.resetsAt,"window-minutes":{reset[5]}.windowDurationMins'
                f'}}),{reset[4]}[0]={reset[5]}.resetsAt'
            )
            edits.append((original, replacement))
            title = re.search(rf'title:({IDENTIFIER}),className:[^;]{{0,250}}children:\1', segment)
            if title is None:
                raise ValueError('Unsupported Codex build: composer reset title anchor does not match.')
            edits.append((title[0], title[0].replace(f'title:{title[1]},', '')))
    for original, replacement in edits:
        if js.count(original) != 1:
            raise ValueError('Unsupported Codex build: composer usage anchor is ambiguous.')
        js = js.replace(original, replacement, 1)
    asset = ASSET.read_text()
    asset = f'const scmToolkitUsageResetCountdown = {str(bool(reset_countdown)).lower()};\n' + asset
    if hide_reset_times:
        asset = 'const scmToolkitHideUsageResetTimes = true;\n' + asset
    return js + START + '/* edits:' + json.dumps(edits) + ' */\n' + asset + END


def patch_files(extension_path=None, enabled=True, hide_reset_times=False, pie_indicator=False,
                reset_countdown=True):
    candidates = ([Path(extension_path)] if extension_path else
                  sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True))
    for candidate in candidates:
        for path in (candidate / 'webview/assets').glob('composer-utility-bar-*.js'):
            original = path.read_text()
            if START in original or 'id:`composer.mode.local`' in original:
                yield path, original, transform(
                    original, enabled, hide_reset_times, pie_indicator, reset_countdown
                )
