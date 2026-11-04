"""Install a guarded PR Send-button helper in the Integrated Browser preload."""
from pathlib import Path
import re

START = '\n/* sweetiebot-browser-pr:start */\n'
END = '\n/* sweetiebot-browser-pr:end */\n'
ASSET = Path(__file__).resolve().parent.parent / 'assets/browser/pull_request_submit.js'
THINKING_ASSET = ASSET.with_name('maximize_thinking.js')
SPELLCHECK_ASSET = ASSET.with_name('spellcheck_bridge.js')
BACKGROUND_ASSET = ASSET.with_name('pr_background.js')
BACKGROUND_START = '/* sweetiebot-browser-background:start */'
BACKGROUND_END = '/* sweetiebot-browser-background:end */'
BACKGROUND_ANCHOR = 'this.setupEventListeners()}static{this.MAX_CONSOLE_LOG_ENTRIES='
STORAGE_START = '/* sweetiebot-pr-storage:start */'
STORAGE_END = '/* sweetiebot-pr-storage:end */'
SHARED_BROWSER_PROFILE = 2


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
    affinity_session = re.search(
        rf'static getOrCreateWorkspace\(({ident}),({ident}),({ident}),({ident}),({ident})\)'
        rf'\{{let ({ident})=\5===void 0\?void 0:({ident})\("sha256"\)\.update\(\5\)\.digest\("hex"\),'
        rf'({ident})=\6\?({ident})\(({ident})\.getWorkspaceAffinityStorageHome\(\3,\2\),\6\):\9\(\3,\2,"browserStorage"\),'
        rf'({ident})=\6\?`workspace:\$\{{\2\}}:\$\{{\6\}}`:`workspace:\$\{{\2\}}`,'
        rf'({ident})=({ident})\.fromPath\(\8\.fsPath\);return \10\._bySession\.get\(\12\)'
        rf'\?\?\1\.createInstance\(\10,\11,\12,"workspace",\4,\5\)\}}',
        source,
    )
    resolver = re.compile(
        rf'(?:return |let {ident}=)(({ident})\.getOrCreate\(this\.instantiationService,({ident}),({ident}),'
        rf'this\.environmentMainService\.workspaceStorageHome,({ident})\.openedWorkspace\?\.id,({ident})\))'
    )
    matches = list(resolver.finditer(source))
    if len(matches) != 1 or bool(session) == bool(affinity_session):
        raise ValueError('Unsupported Integrated Browser persistent session lifecycle.')
    match = matches[0]
    cls, options = match[2], match[4]
    if affinity_session:
        join, electron, session_cls = affinity_session[9], affinity_session[13], affinity_session[10]
    else:
        join, electron, session_cls = session[5], session[7], session[8]
    if session_cls != cls:
        raise ValueError('Unsupported Integrated Browser persistent session lifecycle.')
    # Ordinary repository and PR windows share the same persistent profile.
    # Ephemeral and agent sessions retain their isolation and network protections.
    insertion = (
        STORAGE_START
        + f'(({options}.scope==="workspace"||{options}.scope==="global")'
        + (f'&&{options}.network===void 0&&{options}.affinity===void 0' if affinity_session else '')
        + ')?(()=>{let sweetiebotPath='
        + f'{join}(this.environmentMainService.userHome,"Library","Application Support","Sweetiebot","browserStorage"),'
        + f'sweetiebotSession={electron}.fromPath(sweetiebotPath.fsPath);'
        + f'return {cls}._bySession.get(sweetiebotSession)??this.instantiationService.createInstance({cls},"sweetiebot-pr",sweetiebotSession,"workspace"'
        + (',void 0,void 0' if affinity_session else '') + ')'
        + '})():' + STORAGE_END
    )
    return source[:match.start(1)] + insertion + source[match.start(1):]


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
