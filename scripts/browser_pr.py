"""Install a guarded PR Send-button helper in the Integrated Browser preload."""
from pathlib import Path
import re

START = '\n/* sweetiebot-browser-pr:start */\n'
END = '\n/* sweetiebot-browser-pr:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/browser/pull_request_submit.js'
BACKGROUND_ASSET = ASSET.with_name('pr_background.js')
BACKGROUND_START = '/* sweetiebot-browser-background:start */'
BACKGROUND_END = '/* sweetiebot-browser-background:end */'
BACKGROUND_ANCHOR = 'this.setupEventListeners()}static{this.MAX_CONSOLE_LOG_ENTRIES='
STORAGE_START = '/* sweetiebot-pr-storage:start */'
STORAGE_END = '/* sweetiebot-pr-storage:end */'


def transform_storage(source, remove=False):
    if (source.count(STORAGE_START) != source.count(STORAGE_END)
            or source.count(STORAGE_START) > 1):
        raise ValueError('Incomplete Sweetiebot PR browser storage patch.')
    if STORAGE_START in source:
        before, remainder = source.split(STORAGE_START, 1)
        _, after = remainder.split(STORAGE_END, 1)
        source = before + after
    if remove:
        return source
    ident = r'[A-Za-z_$][\w$]*'
    session = re.search(
        rf'static getOrCreateWorkspace\(({ident}),({ident}),({ident})\)'
        rf'\{{let ({ident})=({ident})\(\3,\2,"browserStorage"\),'
        rf'({ident})=({ident})\.fromPath\(\4\.fsPath\);return ({ident})\._bySession',
        source,
    )
    resolver = re.compile(
        rf'return ({ident})\.getOrCreate\(this\.instantiationService,({ident}),({ident}),'
        rf'this\.environmentMainService\.workspaceStorageHome,({ident})\.openedWorkspace\?\.id,({ident})\)'
    )
    matches = list(resolver.finditer(source))
    if not session or len(matches) != 1 or session[8] != matches[0][1]:
        raise ValueError('Unsupported Integrated Browser persistent session lifecycle.')
    match = matches[0]
    cls, options, window = match[1], match[3], match[4]
    join, electron = session[5], session[7]
    # Only trusted workspace-scoped PR sessions share this profile. Ephemeral
    # and agent sessions retain VS Code's isolation and network protections.
    insertion = (
        STORAGE_START
        + f'if({options}.scope==="workspace"&&/\\/sweetiebot-pr-sessions\\/session-[^/]+\\/[^/]+\\.code-workspace$/.test({window}.openedWorkspace?.configPath?.path??""))'
        + '{let sweetiebotPath='
        + f'{join}(this.environmentMainService.userHome,"Library","Application Support","Sweetiebot","browserStorage"),'
        + f'sweetiebotSession={electron}.fromPath(sweetiebotPath.fsPath);'
        + f'return {cls}._bySession.get(sweetiebotSession)??this.instantiationService.createInstance({cls},"sweetiebot-pr",sweetiebotSession,"workspace")'
        + '}' + STORAGE_END
    )
    return source[:match.start()] + insertion + source[match.start():]


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
    return source + START + ASSET.read_text() + END


def patch_files(app, remove=False):
    path = app / 'Contents/Resources/app/out/vs/platform/browserView/electron-browser/preload-browserView.js'
    old = path.read_text()
    main = app / 'Contents/Resources/app/out/mainImpl.js'
    main_old = main.read_text()
    return [(path, old, transform(old, remove)),
            (main, main_old, transform_storage(transform_background(main_old, remove), remove))]
