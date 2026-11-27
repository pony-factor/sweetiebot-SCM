"""Install a guarded PR Send-button helper in the Integrated Browser preload."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

from pathlib import Path
import re

START = '\n/* sweetiebot-browser-pr:start */\n'
END = '\n/* sweetiebot-browser-pr:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/browser/pull-request-submit.js'
THINKING_ASSET = ASSET.with_name('maximize-thinking.js')
SPELLCHECK_ASSET = ASSET.with_name('spellcheck-bridge.js')
BACKGROUND_ASSET = ASSET.with_name('pr-background.js')
BACKGROUND_START = '/* sweetiebot-browser-background:start */'
BACKGROUND_END = '/* sweetiebot-browser-background:end */'
BACKGROUND_ANCHOR = 'this.setupEventListeners()}static{this.MAX_CONSOLE_LOG_ENTRIES='
STORAGE_START = '/* sweetiebot-pr-storage:start */'
STORAGE_END = '/* sweetiebot-pr-storage:end */'
GLOBAL_STORAGE_START = '/* sweetiebot-global-storage:start */'
GLOBAL_STORAGE_END = '/* sweetiebot-global-storage:end */'
SHARED_BROWSER_PROFILE = 6


def transform_storage(source, remove=False):
    for start, end, original in ((STORAGE_START, STORAGE_END, ''),
                                 (GLOBAL_STORAGE_START, GLOBAL_STORAGE_END, '){')):
        if source.count(start) != source.count(end) or source.count(start) > 1:
            raise ValueError('Incomplete Sweetiebot browser storage patch.')
        if start in source:
            before, remainder = source.split(start, 1)
            _, after = remainder.split(end, 1)
            source = before + original + after
    if remove:
        return source
    ident = r'[A-Za-z_$][\w$]*'
    global_factory = re.compile(
        rf'static getOrCreateGlobal\((?P<service>{ident})(?P<header>\)\{{)'
        rf'let (?P<session>{ident})=(?P<electron>{ident})\.fromPartition\("persist:vscode-browser"\);'
        rf'return (?P<cls>{ident})\._bySession\.get\((?P=session)\)\?\?'
        r'(?P=service)\.createInstance\((?P=cls),"global",(?P=session),"global"(?P<extra>(?:,void 0)*)\)\}'
    )
    resolver = re.compile(
        rf'({ident})\.getOrCreate\(this\.instantiationService,({ident}),({ident}),'
        rf'this\.environmentMainService\.workspaceStorageHome,({ident})\.openedWorkspace\?\.id,({ident})\)'
    )
    factories = list(global_factory.finditer(source))
    matches = list(resolver.finditer(source))
    if len(factories) != 1 or len(matches) != 1 or factories[0]['cls'] != matches[0][1]:
        raise ValueError('Unsupported Integrated Browser persistent session lifecycle.')
    factory = factories[0]
    match = matches[0]
    cls, options = match[1], match[3]
    # Override the global factory itself so native callers, including Clear Global
    # Storage, resolve the same store as ordinary workspace browser tabs.
    global_insertion = (
        GLOBAL_STORAGE_START + ',sweetiebotUseNative=false){if(!sweetiebotUseNative){'
        + f'let sweetiebotSession={factory["electron"]}.fromPartition("persist:sweetiebot-browser");'
        + '(' + ASSET.with_name('session-persistence.js').read_text() + ')(sweetiebotSession);'
        + f'return {cls}._bySession.get(sweetiebotSession)??{factory["service"]}.createInstance('
        + f'{cls},"sweetiebot-pr",sweetiebotSession,"global"{factory["extra"]})}}' + GLOBAL_STORAGE_END
    )
    isolated = f'({options}.network!==void 0||{options}.affinity!==void 0)'
    insertion = (
        STORAGE_START
        + f'{options}.scope==="workspace"&&!{isolated}?{cls}.getOrCreateGlobal(this.instantiationService):'
        + f'{options}.scope==="global"&&{isolated}?{cls}.getOrCreateGlobal(this.instantiationService,true):'
        + STORAGE_END
    )
    for start, end, text in sorted(((match.start(), match.start(), insertion),
                                   (*factory.span('header'), global_insertion)), reverse=True):
        source = source[:start] + text + source[end:]
    return source


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
    return source + START + THINKING_ASSET.read_text() + '\n' + ASSET.read_text() + '\n' + SPELLCHECK_ASSET.read_text() + END


def patch_files(app, remove=False):
    path = app / 'Contents/Resources/app/out/vs/platform/browserView/electron-browser/preload-browserView.js'
    old = path.read_text()
    main = app / 'Contents/Resources/app/out/mainImpl.js'
    main_old = main.read_text()
    return [(path, old, transform(old, remove)),
            (main, main_old, transform_storage(transform_background(main_old, remove), remove))]
