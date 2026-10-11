"""Install a guarded PR Send-button helper in the Integrated Browser preload."""
from pathlib import Path

START = '\n/* sweetiebot-browser-pr:start */\n'
END = '\n/* sweetiebot-browser-pr:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/browser/pull_request_submit.js'
FRESH_TAB_ASSET = Path(__file__).resolve().parent.parent / 'assets/browser/chatgpt_fresh_tab.js'
BACKGROUND_ASSET = ASSET.with_name('pr_background.js')
BACKGROUND_START = '/* sweetiebot-browser-background:start */'
BACKGROUND_END = '/* sweetiebot-browser-background:end */'
BACKGROUND_ANCHOR = 'this.setupEventListeners()}static{this.MAX_CONSOLE_LOG_ENTRIES='


def transform_background(source, remove=False):
    if source.count(BACKGROUND_START) != source.count(BACKGROUND_END) or source.count(BACKGROUND_START) > 1:
        raise ValueError('Incomplete browser background helper; refusing to overwrite it.')
    if BACKGROUND_START in source:
        before, remainder = source.split(BACKGROUND_START, 1)
        _, after = remainder.split(BACKGROUND_END, 1)
        source = before + after
    if remove:
        return source
    if source.count(BACKGROUND_ANCHOR) != 1:
        raise ValueError('Unsupported Integrated Browser background lifecycle.')
    insertion = BACKGROUND_START + ';' + BACKGROUND_ASSET.read_text() + BACKGROUND_END
    return source.replace(BACKGROUND_ANCHOR, 'this.setupEventListeners()' + insertion + '}static{this.MAX_CONSOLE_LOG_ENTRIES=', 1)


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
    return source + START + FRESH_TAB_ASSET.read_text() + '\n' + ASSET.read_text() + END


def patch_files(app, remove=False):
    path = app / 'Contents/Resources/app/out/vs/platform/browserView/electron-browser/preload-browserView.js'
    old = path.read_text()
    main = app / 'Contents/Resources/app/out/mainImpl.js'
    main_old = main.read_text()
    return [(path, old, transform(old, remove)), (main, main_old, transform_background(main_old, remove))]
