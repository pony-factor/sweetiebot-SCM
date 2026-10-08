"""Install a guarded PR Send-button helper in the Integrated Browser preload."""
from pathlib import Path

START = '\n/* sweetiebot-browser-pr:start */\n'
END = '\n/* sweetiebot-browser-pr:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/browser/pull_request_submit.js'


def transform(source, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete browser PR helper; refusing to overwrite it.')
    if START in source:
        before, remainder = source.split(START, 1)
        _, after = remainder.split(END, 1)
        source = before + after
    if remove:
        return source
    if 'vscode:browserView:preloadReady' not in source:
        raise ValueError('Unsupported Integrated Browser preload.')
    return source + START + ASSET.read_text() + END


def patch_files(app, remove=False):
    path = app / 'Contents/Resources/app/out/vs/platform/browserView/electron-browser/preload-browserView.js'
    old = path.read_text()
    return [(path, old, transform(old, remove))]
