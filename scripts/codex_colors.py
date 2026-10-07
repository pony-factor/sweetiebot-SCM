"""Scoped appearance overrides for the installed Codex IDE composer."""

from pathlib import Path
import json
import re

START = '\n/* scm-toolkit-codex-colors:start */\n'
END = '/* scm-toolkit-codex-colors:end */\n'
COLOR_SETTINGS = (
    "codexSendBackground",
    "codexSendForeground",
    "codexComposerLabelColor",
    "codexDropAccent",
)
APPEARANCE_SETTINGS = COLOR_SETTINGS + ("codexHideAccessLabel",)
FONT_START = '/* scm-toolkit-font-fallback:'
FONT_END = '/* scm-toolkit-font-fallback:end */'


def fallback_fonts(css, remove=False):
    """Use shipped fallback fonts when the webview CSP blocks embedded fonts."""
    wrapped = re.compile(re.escape(FONT_START) + r'(.*?) \*/(.*?)' + re.escape(FONT_END), re.S)
    def restore(match):
        original, replacement = json.loads(match[1])
        if match[2] != replacement:
            raise ValueError('Codex font fallback changed; refusing to overwrite it.')
        return original
    css = wrapped.sub(restore, css)
    if remove:
        return css
    def replace(match):
        original = match[0]
        # Keep the existing local WOFF/TTF alternatives and their font metrics.
        replacement = re.sub(r'url\(data:font/woff2;base64,[A-Za-z0-9+/=]+\)format\("woff2"\),'
                             r'(?=url\(\./)', '', original)
        if original == replacement:
            return original
        return FONT_START + json.dumps([original, replacement]) + ' */' + replacement + FONT_END
    return re.sub(r'@font-face\{[^}]*\}', replace, css)


def validate_color(value):
    value = str(value).strip()
    if value and not re.fullmatch(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})", value):
        raise ValueError("Colors must be hexadecimal, such as #43AF49, or blank to use the theme.")
    return value


def stylesheet_path(extension_path=None):
    candidates = (
        [Path(extension_path)] if extension_path is not None
        else sorted((Path.home() / '.vscode/extensions').glob('openai.chatgpt-*'), reverse=True)
    )
    for candidate in candidates:
        matches = []
        for path in (candidate / 'webview/assets').glob('app-initial-*.css'):
            css = path.read_text()
            if ':root[data-codex-window-type=extension]' in css and '.bg-composer-primary{' in css:
                matches.append(path)
        if len(matches) == 1:
            return matches[0]
    return None


def transform(css, settings, remove=False):
    css = fallback_fonts(css, remove=remove)
    if css.count(START) != css.count(END) or css.count(START) > 1:
        raise ValueError("Incomplete Codex color patch; refusing to overwrite it.")
    if START in css:
        before, remainder = css.split(START, 1)
        _, after = remainder.split(END, 1)
        css = before + after
    if remove:
        return css
    background, foreground, label, drop = [validate_color(settings.get(key, '')) for key in COLOR_SETTINGS]
    scope = ':root[data-codex-window-type=extension]'
    rules = []
    if settings.get('codexHideAccessLabel', False):
        # Keep the current mode in the accessibility tree via aria-describedby.
        # The icon is a sibling of the value, so it stays visible and clickable.
        rules.append(
            f'{scope} button[data-composer-navigation-target="permissions"] '
            '[class*="ComposerDropdownLabelValue_"] { '
            'position: absolute !important; width: 1px !important; height: 1px !important; '
            'padding: 0 !important; margin: -1px !important; overflow: hidden !important; '
            'clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; '
            'border: 0 !important; display: block !important; }'
        )
    if drop:
        rules.append(f'{scope} {{ --color-codex-drop-overlay: {drop}; --color-codex-drop-prompt: {drop}; }}')
        rules.append(f'{scope} [class*="bg-codex-drop-overlay"] {{ border-color: {drop} !important; }}')
        rules.append(f'{scope} .bg-codex-drop-prompt {{ color: #ffffff !important; border-color: {drop} !important; }}')
    if background:
        rules.append(f'{scope} button.bg-composer-primary {{ background-color: {background} !important; }}')
    if foreground:
        rules.append(f'{scope} button.bg-composer-primary .text-composer-primary {{ color: {foreground} !important; }}')
    if label:
        selectors = [
            f'{scope} button[data-composer-navigation-target="{target}"]{descendant}'
            for target in ('permissions', 'run-location', 'add-context') for descendant in ('', ' *')
        ]
        rules.append(',\n'.join(selectors) + f' {{ color: {label} !important; }}')
    return css + START + '\n'.join(rules) + '\n' + END if rules else css
