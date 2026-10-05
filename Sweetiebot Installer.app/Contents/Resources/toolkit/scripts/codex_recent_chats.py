"""Keep the Codex home preview to the seven most recent chats."""

import json
import re

START = '\n/* scm-toolkit-codex-recent-chats:start */\n'
END = '\n/* scm-toolkit-codex-recent-chats:end */\n'
ANCHOR = 'header.recentTasks.seeAll'


def transform(source, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex recent-chat patch.')
    if START in source:
        before, remainder = source.split(START, 1)
        payload, after = remainder.split(END, 1)
        original, replacement = json.loads(payload.strip())
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed Codex recent-chat patch changed.')
        source = source.replace(replacement, original, 1)
    if remove or ANCHOR not in source or 'defaultMessage:' not in source:
        return source
    ident = r'[A-Za-z_$][\w$]*'
    pattern = re.compile(
        rf'(?P<preview>{ident})=\(0,{ident}\.default\)'
        rf'\(\[\.\.\.(?P<unread>{ident}),\.\.\.(?P<tasks>{ident})\],{ident}\)'
        rf'\.slice\(0,Math\.max\(3,(?P=unread)\.length\)\)'
    )
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError('Unsupported Codex build: recent-chat preview does not match.')
    match = matches[0]
    original = match.group(0)
    replacement = f'{match["preview"]}={match["tasks"]}.slice(0,7)'
    source = source.replace(original, replacement, 1)
    return source + START + json.dumps([original, replacement]) + END
