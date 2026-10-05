"""Scoped appearance overrides for the installed Codex IDE composer."""

from pathlib import Path
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
