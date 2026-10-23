#!/usr/bin/env python3
"""Apply, validate, or remove the custom VS Code SCM toolkit patch."""

import argparse
import base64
import json
import os
import re
import workspace_search
import codex_colors
import codex_label
import codex_composer
import codex_usage
import codex_context
import codex_drafts
import codex_keep_awake
import codex_image_drop
import codex_recent_chats
import codex_startup
import github_pr
import browser_pr
from pathlib import Path
from toolkit_settings import DEFAULT_SETTINGS, load_settings, persist_message_bar_layout, read_git_bool, read_git_string
from branch_names import resolve_runtime_settings

HERE = Path(__file__).resolve().parent
WORKBENCH_ASSETS = HERE.parent / "assets/workbench"
CODEX_ASSETS = HERE.parent / "assets/codex"
TWILIGHT_STOP_PNG = HERE.parent / "assets/images/twi-stop.png"
START = '\n/* scm-toolkit:start */\n'
END = '\n/* scm-toolkit:end */\n'
CODEX_START = '\n/* scm-toolkit-codex-countdown:start */\n'
CODEX_END = '\n/* scm-toolkit-codex-countdown:end */\n'
CODEX_HIDE_RESET_START = '\n/* scm-toolkit-codex-hide-reset-times:start */\n'
CODEX_HIDE_RESET_END = '\n/* scm-toolkit-codex-hide-reset-times:end */\n'
CODEX_LIMIT_START = '\n/* scm-toolkit-codex-limit-controls:start */\n'
CODEX_LIMIT_END = '\n/* scm-toolkit-codex-limit-controls:end */\n'
CODEX_PROMOTIONS_START = '\n/* scm-toolkit-codex-promotions:start */\n'
CODEX_PROMOTIONS_END = '\n/* scm-toolkit-codex-promotions:end */\n'
CODEX_TIMESTAMPS_START = '\n/* scm-toolkit-codex-timestamps:start */\n'
CODEX_TIMESTAMPS_END = '\n/* scm-toolkit-codex-timestamps:end */\n'
CODEX_DICTATION_START = '\n/* scm-toolkit-codex-dictation:start */\n'
CODEX_DICTATION_END = '\n/* scm-toolkit-codex-dictation:end */\n'

CODEX_LABELS_START = '\n/* scm-toolkit-codex-model-labels:start */\n'
CODEX_LABELS_END = '\n/* scm-toolkit-codex-model-labels:end */\n'
CODEX_WINDOW_LABEL_START = '\n/* scm-toolkit-codex-window-label:start */\n'
CODEX_WINDOW_LABEL_END = '\n/* scm-toolkit-codex-window-label:end */\n'


def ai_wrapper_path():
    configured = os.environ.get(
        "SCM_TOOLKIT_AI_WRAPPER_PATH", "~/.local/bin/scm-toolkit-git"
    )
    return Path(configured).expanduser()


def legacy_ai_wrapper_path():
    return Path("~/.local/bin/git-auto-title").expanduser()


def sync_ai_wrapper(remove=False, check=False, destination=None):
    primary = Path(destination) if destination is not None else ai_wrapper_path()
    primary_files = [
        (HERE / "ai_commit.py", primary),
        (HERE / "sweetiebot_async_commit.py", primary.with_name("sweetiebot_async_commit.py")),
        (HERE / "background_commit.py", primary.with_name("background_commit.py")),
        (HERE / "merged_branch.py", primary.with_name("merged_branch.py")),
        (HERE / "cloud_repo_sync.py", primary.with_name("cloud_repo_sync.py")),
        (HERE / "sweetiebot_diagnostics.py", primary.with_name("sweetiebot_diagnostics.py")),
        (
            HERE / "post_commit_spellcheck.py",
            primary.with_name(primary.name + "-spellcheck.py"),
        ),
    ]

    # The normal installer passes destination=ai_wrapper_path(). Treat that
    # exact call as the canonical install path too, so legacy wrappers cannot
    # escape refresh merely because the destination was supplied explicitly.
    manage_legacy = destination is None or primary == ai_wrapper_path()
    legacy = legacy_ai_wrapper_path()
    legacy_links = []
    if (
        manage_legacy
        and legacy != primary
        and (legacy.exists() or legacy.is_symlink())
    ):
        legacy_links = [
            (legacy, primary),
            (
                legacy.with_name(legacy.name + "-spellcheck.py"),
                primary.with_name(primary.name + "-spellcheck.py"),
            ),
        ]

    # The canonical wrapper remains a managed regular file. Existing legacy
    # names are allowed to be symlinks because they are migrated below.
    for _, target in primary_files:
        if not remove and target.is_symlink():
            raise RuntimeError(f"Refusing to overwrite symlinked AI wrapper: {target}")

    changed = False
    for source, target in primary_files:
        if remove:
            exists = target.exists() or target.is_symlink()
            changed |= exists
            if exists and not check:
                target.unlink()
            continue
        expected = source.read_bytes()
        current = target.read_bytes() if target.exists() else None
        executable = target.exists() and bool(target.stat().st_mode & 0o111)
        needs_update = current != expected or not executable
        changed |= needs_update
        if needs_update and not check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(expected)
            target.chmod(0o755)

    for legacy_target, canonical_target in legacy_links:
        if remove:
            exists = legacy_target.exists() or legacy_target.is_symlink()
            changed |= exists
            if exists and not check:
                legacy_target.unlink()
            continue

        points_to_canonical = (
            legacy_target.is_symlink()
            and legacy_target.resolve(strict=False)
            == canonical_target.resolve(strict=False)
        )
        changed |= not points_to_canonical
        if not points_to_canonical and not check:
            if legacy_target.exists() or legacy_target.is_symlink():
                legacy_target.unlink()
            legacy_target.parent.mkdir(parents=True, exist_ok=True)
            legacy_target.symlink_to(canonical_target)

    return changed

def ai_model_picker_path():
    configured = os.environ.get(
        "SCM_TOOLKIT_MODEL_PICKER_PATH", "~/.local/bin/scm-toolkit-models"
    )
    return Path(configured).expanduser()


def sync_model_picker(enabled=True, remove=False, check=False, destination=None):
    destination = (
        Path(destination) if destination is not None else ai_model_picker_path()
    )
    source = HERE / "model_picker.py"
    should_remove = remove or not enabled

    if should_remove:
        changed = destination.exists() or destination.is_symlink()
        if changed and not check:
            destination.unlink()
        return changed

    if destination.is_symlink():
        raise RuntimeError(f"Refusing to overwrite symlinked model picker: {destination}")

    expected = source.read_bytes()
    current = destination.read_bytes() if destination.exists() else None
    executable = destination.exists() and bool(destination.stat().st_mode & 0o111)
    changed = current != expected or not executable

    if changed and not check:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(expected)
        destination.chmod(0o755)

    return changed


def unpack_edit(edit):
    if len(edit) == 2:
        original, replacement = edit
        return original, replacement, 1
    original, replacement, expected_count = edit
    return original, replacement, expected_count


def graph_open_working_file_edits(js):
    anchor = "workbench.scm.action.graph.openFile"
    anchor_index = js.find(anchor)
    if anchor_index < 0:
        raise ValueError(
            "Unsupported VS Code build: Source Control Graph Open File anchor does not match."
        )

    segment = js[anchor_index : anchor_index + 6000]
    pattern = re.compile(
        r"(?P<prefix>[A-Za-z_$][\w$]*\.openEditor\(\{resource:)"
        r"(?P<change>[A-Za-z_$][\w$]*)\.modifiedUri"
        r"(?P<suffix>,label:)"
    )
    matches = list(pattern.finditer(segment))
    if len(matches) != 1:
        raise ValueError(
            "Unsupported VS Code build: Source Control Graph Open File action does not match."
        )

    match = matches[0]
    original = match.group(0)
    # VS Code keeps an untouched browser tab URL as an empty string. Treat that
    # as blank too so native New Tab actions keep receiving the configured home.
    replacement = (
        f'{match.group("prefix")}{match.group("change")}.modifiedUri'
        '.with({scheme:"file",query:""})'
        f'{match.group("suffix")}'
    )
    return [(original, replacement)]


def source_control_label_edits(js, label):
    if label == "Source Control":
        return []

    anchor = 'workbench.scm.views.state'
    anchor_indexes = [match.start() for match in re.finditer(re.escape(anchor), js)]
    if len(anchor_indexes) != 1:
        raise ValueError(
            "Unsupported VS Code build: Source Control view-container anchor does not match."
        )

    anchor_index = anchor_indexes[0]
    start = max(0, anchor_index - 800)
    segment = js[start : anchor_index + len(anchor)]
    matches = list(re.finditer(
        r"""title\s*:\s*[\w$]+\(\s*(?:\d+|"[^"]*"|'[^']*')\s*,\s*(["'])Source Control\1\s*\)""",
        segment,
    ))
    if len(matches) != 1:
        raise ValueError(
            "Unsupported VS Code build: Source Control app-bar label does not match."
        )

    match = matches[0]
    suffix = segment[match.end() :]
    original = match.group(0) + suffix
    # localize2 uses the numeric NLS entry before its fallback text. A custom
    # label must supply both title fields directly to bypass that lookup.
    replacement = "title:" + json.dumps({"value": str(label), "original": str(label)}) + suffix
    edits = [(original, replacement)]
    # Moving Changes into the panel uses its view title instead of the original
    # container title. Follow the shared containerTitle variable in that view.
    views = js[anchor_index:anchor_index + 4000]
    identifier = r"[A-Za-z_$][\w$]*"
    view = re.search(
        rf'containerTitle:(?P<title>{identifier}),name:{identifier}\('
        rf'(?:\d+|"[^"]*"),"Changes"\),singleViewPaneContainerTitle:(?P=title)',
        views,
    )
    if view:
        assignments = list(re.finditer(
            rf'(?<![\w$]){re.escape(view.group("title"))}={identifier}\([^;]*?\)',
            views[:view.start()],
        ))
        if len(assignments) != 1:
            raise ValueError("Unsupported VS Code build: Source Control panel title does not match.")
        original = assignments[0].group(0)
        edits.append((original, view.group("title") + "=" + json.dumps(str(label))))
    return edits


def browser_globe_new_tab_edits(js, home_url=None):
    ident = r"[A-Za-z_$][\w$]*"
    pattern = re.compile(
        rf"id:(?P<commands>{ident})\.OpenOrList,.*?"
        rf"async run\((?P<accessor>{ident})\)\{{"
        rf"let {ident}=(?P=accessor)\.get\({ident}\),"
        rf"{ident}=(?P=accessor)\.get\((?P<service>{ident})\);"
        rf"if\({ident}\.getContextualBrowserViews\(\)\.size>0\)"
    )
    matches = list(pattern.finditer(js))
    if len(matches) != 1:
        raise ValueError("Unsupported VS Code build: browser globe action does not match.")
    match = matches[0]
    original = match.group(0)
    start = f'async run({match.group("accessor")}){{'
    # VS Code's native NewTab action unconditionally opens the URL picker,
    # even when our browser resolver assigns a homepage. Opening with an
    # explicit URL avoids that picker and lets the loaded page receive focus.
    command = "Open" if home_url is not None else "NewTab"
    destination = (
        f',{json.dumps(home_url or "https://chatgpt.com/")}'
        if home_url is not None else ""
    )
    replacement = original.replace(
        start,
        start + f'return {match.group("accessor")}.get({match.group("service")})'
        f'.executeCommand({match.group("commands")}.{command}{destination});',
        1,
    )
    return [(original, replacement)]



def browser_cross_window_reopen_edits(js):
    """Reopen foreign browser editor IDs instead of attaching to their native view."""
    anchor = "closed during creation"
    if anchor not in js:
        return []  # Older builds without the native Integrated Browser.

    ident = r"[A-Za-z_$][\w$]*"
    pattern = re.compile(
        rf"getOrCreateLazy\((?P<data>{ident})\)"
        rf"\{{return this\._getOrCreateLazy\((?P=data)\)\}}"
    )
    # Restrict the match to the service containing the browser-creation error,
    # rather than rewriting another module's similarly named public method.
    matches = [
        match for match in pattern.finditer(js)
        if 0 < js.find(anchor, match.end()) - match.end() < 12000
    ]
    if len(matches) != 1:
        raise ValueError(
            "Unsupported VS Code build: browser view window handoff does not match."
        )

    match = matches[0]
    data = match.group("data")
    original = match.group(0)
    # The main process returns an existing browser view without emitting a
    # creation event to a *different* workbench window that imported its ID.
    # Keep locally registered views (also used by native auxiliary windows);
    # otherwise reopen the saved URL under a fresh view ID in the target.
    replacement = (
        f"getOrCreateLazy({data}){{return this._getOrCreateLazy("
        f"this._known.has({data}.id)?{data}:"
        f"{{...{data},id:globalThis.crypto.randomUUID()}})}}"
    )
    return [(original, replacement)]


def browser_chatgpt_home_edits(js, home_url="https://chatgpt.com/"):
    anchor = "Invalid browser view resource:"
    anchor_index = js.find(anchor)
    if anchor_index < 0:
        raise ValueError(
            "Unsupported VS Code build: Integrated Browser resolver anchor does not match."
        )

    segment = js[anchor_index : anchor_index + 4000]
    pattern = re.compile(
        r"(?P<prefix>[A-Za-z_$][\w$]*\.getOrCreateLazy\(\{id:"
        r"[A-Za-z_$][\w$]*\.id,\.\.\.(?P<options>[A-Za-z_$][\w$]*)"
        r"\?\.viewState)(?P<suffix>\}\))"
    )
    matches = list(pattern.finditer(segment))
    if len(matches) != 1:
        raise ValueError(
            "Unsupported VS Code build: Integrated Browser resolver does not match."
        )

    match = matches[0]
    original = match.group(0)
    destination = home_url or "https://chatgpt.com/"
    replacement = (
        f'{match.group("prefix")},url:{match.group("options")}?.viewState?.url'
        f'||{json.dumps(destination)}{match.group("suffix")}'
    )
    return [(original, replacement)]


def extension_update_toolbar_edits(js):
    changes = []
    search_toolbar = re.search(
        r'extensions-search-actions-container"\)\);this\._register\(this\.instantiationService\.createInstance\('
        r'[\w$]+,[\w$]+,([\w$]+),\{toolbarOptions:', js
    )
    for command in ("checkForUpdates", "updateAllExtensions"):
        anchor = f'id:"workbench.extensions.action.{command}"'
        if anchor not in js:
            continue
        start = js.index(anchor)
        segment = js[start:start + 800]
        match = re.search(r'group:"1_updates",order:[12]', segment)
        if not match:
            raise ValueError("Unsupported VS Code build: extension update menu does not match.")
        original = segment[:match.end()]
        replacement = original
        if search_toolbar:
            # This toolbar belongs to the Extensions search header itself, so
            # its actions survive moving the view between sidebar and panel.
            replacement = replacement.replace(
                'menu:[',
                f'menu:[{{id:{search_toolbar.group(1)},group:"navigation",order:'
                f'{1 if command == "checkForUpdates" else 2}}},',
                1,
            )
        changes.append((original, replacement))
    return changes


def window_title_status_edits(js):
    # Accessibility can append activeEditorState implicitly. Native VS Code only
    # listens for decoration changes when the title template includes it
    # explicitly, leaving e.g. "Modified" behind after an external commit.
    # Subscribe for every active editor, including accessibility mode changes.
    original = (
        'this.titleIncludesEditorState&&this.activeEditorListeners.add('
        'this.decorationsService.onDidChangeDecorations(()=>this.titleUpdater.schedule()))'
    )
    if original not in js:
        if 'checkTitleVariables(){' in js:
            raise ValueError("Unsupported VS Code build: window title status listener does not match.")
        return []  # Older builds and synthetic fixtures without the title service.
    if js.count(original) != 1:
        raise ValueError("Unsupported VS Code build: window title status listener is ambiguous.")
    return [(original, original.removeprefix('this.titleIncludesEditorState&&'))]


def compact_window_edits(js, command="fe", configuration="Xe"):
    # Match the native titlebar layout rather than relying on SCM activation.
    ident = r"[A-Za-z_$][\w$]*"
    pattern = re.compile(
        r"layout\(" + ident + r"," + ident + r"\)\{if\(super\.layout\("
        + ident + r"," + ident + r"\)," + ident
        + r"\(this\.configurationService\)\)\{.{0,500}?"
        + r"this\.nativeHostService\.updateWindowControls"
    )
    matches = list(pattern.finditer(js))
    if len(matches) != 1:
        raise ValueError("Unsupported VS Code build: native titlebar layout does not match.")
    original = matches[0].group(0)
    replacement = original.replace(
        "{if(",
        "{this.instantiationService.invokeFunction(accessor=>scmToolkitMountCompactWindow("
        f"this.element.ownerDocument,this.nativeHostService,accessor.get({command}),"
        f"accessor.get({configuration}),scmToolkitSettings));if(",
        1,
    )
    return [(original, replacement)]


def workspace_trust_edits(js):
    ident = r"[A-Za-z_$][\w$]*"
    def unique(pattern):
        matches = re.findall(pattern, js)
        if len(matches) != 1:
            raise ValueError("Unsupported VS Code build: workspace trust API does not match.")
        return matches[0]
    registry = unique(r'(' + ident + r')\.registerCommand\("noop",\(\)=>\{\}\)')
    paths = unique(r'(' + ident + r')=\w+\("pathService"\)')
    requests = unique(r'(' + ident + r')=\w+\("workspaceTrustRequestService"\)')
    original = registry + '.registerCommand("noop",()=>{});'
    replacement = original + registry + '.registerCommand("sweetiebot.requestIndependentWorkspaceTrust",'
    replacement += ('accessor=>scmToolkitRequestIndependentWorkspaceTrust('
                    f'accessor.get({paths}).localUserHome,accessor.get({requests})));')
    replacement += registry + '.registerCommand("sweetiebot.kefaniaThemeColors",()=>scmToolkitKefaniaThemeColors());'
    return [(original, replacement)]


def pr_workspace_explorer_edits(js):
    """Show contents directly in every healthy single-folder workspace.

    This alters the tree input, not the workbench's saved workspace identity.
    """
    marker = "explorer.expandSingleFolderWorkspaces"
    if marker not in js:
        return []  # Synthetic fixtures and older builds without this feature.
    ident = r"[A-Za-z_$][\w$]*"
    # VS Code 1.142 inlines WorkbenchState.FOLDER as 2.
    pattern = re.compile(
        rf"(?P<state>this\.contextService\.getWorkbenchState\(\)!==(?:{ident}\.FOLDER|2))"
        rf"\|\|(?P<roots>{ident})\[0\]\.error"
    )
    matches = [
        match for match in pattern.finditer(js)
        if 0 <= js.find(marker, match.end()) - match.end() < 16000
    ]
    if len(matches) != 1:
        raise ValueError(
            "Unsupported VS Code build: Explorer single-root input anchor does not match."
        )
    match = matches[0]
    roots = match.group("roots")
    replacement = (
        f"({match.group('state')}&&!scmToolkitIsSingleRoot("
        f"this.contextService.getWorkspace(),{roots}))||{roots}[0].error"
    )
    # Scope the label to Explorer; other workspace/window labels stay native.
    # Parameter names vary across builds, so match the setter independently.
    title_pattern = re.compile(
        r"get singleViewPaneContainerTitle\(\)\{return this\.name\}"
        r"get autoReveal\(\)\{return this\._autoReveal\}"
        rf"set autoReveal\((?P<arg>{ident})\)\{{this\._autoReveal=(?P=arg)\}}"
        r"get name\(\)\{return this\.labelService\.getWorkspaceLabel\(this\.contextService\.getWorkspace\(\)\)\}"
    )
    titles = list(title_pattern.finditer(js))
    if len(titles) != 1:
        raise ValueError("Unsupported VS Code build: Explorer contents title anchor does not match.")
    original_title = titles[0].group(0)
    new_title = original_title.replace(
        "get name(){return ",
        'get name(){return this.contextService.getWorkspace().folders.length===1?this.contextService.getWorkspace().folders[0].name:',
        1,
    )
    return [(match.group(0), replacement), (original_title, new_title)]


def edits(js=None, settings=None):
    command, notification, configuration, mcp, observe, dimension = "fe", "Le", "Xe", "Me", "pe", "xi"
    ident = r"[A-Za-z_$][\w$]*"

    if js is not None:
        def unique(pattern):
            matches = re.findall(pattern, js)
            if len(matches) != 1:
                raise ValueError("Unsupported VS Code build: internal API does not match.")
            return matches[0]

        command = unique(r"(" + ident + r')=\w+\("commandService"\)')
        notification = unique(r"(" + ident + r')=\w+\("notificationService"\)')
        configuration = unique(r"(" + ident + r')=\w+\("configurationService"\)')
        mcp = unique(r"(" + ident + r')=\w+\("IMcpService"\)')
        observe = unique(
            r"function (" + ident + r")\(s,o=" + ident
            + r"\.ofCaller\(\)\)\{return new " + ident
            + r"\(new " + ident + r"\(void 0,void 0,s\),s,void 0,o\)\}"
        )
        dimension = unique(
            r"t=new (" + ident + r")\(this\.element\.clientWidth-e,o\);if\(t\.width<0\)"
        )

    changes = [
        (
            "dispose(){this.disposables?.dispose()}setButton(o){if(this.clear(),!!o){",
            "dispose(){scmToolkitDisposeActionButton(this);this.disposables?.dispose()}"
            "setButton(o){if(scmToolkitDeferActionButtonUpdate(this,o))return;"
            "if(this.clear(),!!o){",
        ),
        (
            "this.disposables.add(this.toolbar)}static{this.ValidationTimeouts=",
            "this.disposables.add(this.toolbar);this.scmToolkitControls="
            f"i.invokeFunction(accessor=>scmToolkitCreateControls(this,{observe},"
            f"accessor.get({command}),accessor.get({notification}),"
            f"accessor.get({configuration}),accessor.get({mcp}),scmToolkitSettings))}}"
            "static{this.ValidationTimeouts=",
        ),
        (
            "this.inputEditor.setModel(void 0),this.model=void 0;return}"
            "let e=o.repository.provider.inputBoxTextModel;",
            "this.inputEditor.setModel(void 0),this.model=void 0;"
            "this.scmToolkitControls.bind(void 0);return}"
            "let e=o.repository.provider.inputBoxTextModel;",
        ),
        (
            "this.toolbar.setInput(o),this.model={input:o,textModel:e}}get selections()",
            "this.toolbar.setInput(o),this.model={input:o,textModel:e};"
            "this.scmToolkitControls.bind(o)}get selections()",
        ),
        (
            f"t=new {dimension}(this.element.clientWidth-e,o);if(t.width<0)",
            f"t=new {dimension}(this.element.clientWidth-e-"
            "(this.scmToolkitControls?.width()??0),o);if(t.width<0)",
        ),
    ]
    if js is not None and settings:
        changes.extend(source_control_label_edits(js, settings["sourceControlLabel"]))

    if js is not None and settings and settings.get("graphOpenWorkingFile"):
        changes.extend(graph_open_working_file_edits(js))

    if js is not None and settings and settings.get("browserGlobeNewTab"):
        home_url = None
        if settings.get("browserChatgptHome"):
            home_url = settings.get("browserHomeUrl", "https://chatgpt.com/")
        changes.extend(browser_globe_new_tab_edits(js, home_url))

    if js is not None:
        changes.extend(browser_cross_window_reopen_edits(js))
        changes.extend(window_title_status_edits(js))
        changes.extend(compact_window_edits(js, command, configuration))
        changes.extend(workspace_trust_edits(js))
        changes.extend(pr_workspace_explorer_edits(js))

    if js is not None and settings and settings.get("browserChatgptHome"):
        changes.extend(browser_chatgpt_home_edits(js, settings.get("browserHomeUrl", "https://chatgpt.com/")))

    if js is not None and settings and settings.get("cmdClickCloseOthers"):
        modifier_pattern = re.compile(
            r"this\.setAltPressed\((" + ident + r")\.altKey\)"
        )
        events = modifier_pattern.findall(js)
        if len(events) != 2:
            raise ValueError(
                "Unsupported VS Code build: tab close-others modifier anchor does not match."
            )

        modifier_edits = {}
        for event in events:
            original = f"this.setAltPressed({event}.altKey)"
            replacement = (
                f"this.setAltPressed({event}.altKey||"
                f"scmToolkitSettings.cmdClickCloseOthers&&{event}.metaKey)"
            )
            key = (original, replacement)
            modifier_edits[key] = modifier_edits.get(key, 0) + 1

        changes.extend(
            (original, replacement, count)
            for (original, replacement), count in modifier_edits.items()
        )

    if js is not None:
        changes.extend(extension_update_toolbar_edits(js))

    return changes


def strip_payload(text):
    if START not in text:
        return text
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError("Unexpected toolkit patch markers; refusing to modify this file.")
    before, rest = text.split(START, 1)
    _, after = rest.split(END, 1)
    return before + after


def strip_codex_payload(text):
    if CODEX_START not in text:
        return text
    if text.count(CODEX_START) != 1 or text.count(CODEX_END) != 1:
        raise ValueError("Unexpected Codex countdown patch markers; refusing to modify this file.")
    before, rest = text.split(CODEX_START, 1)
    _, after = rest.split(CODEX_END, 1)
    return before + after


def strip_codex_promotions_payload(text):
    if CODEX_PROMOTIONS_START not in text:
        return text
    if text.count(CODEX_PROMOTIONS_START) != 1 or text.count(CODEX_PROMOTIONS_END) != 1:
        raise ValueError("Unexpected Codex promotion patch markers; refusing to modify this file.")
    before, rest = text.split(CODEX_PROMOTIONS_START, 1)
    _, after = rest.split(CODEX_PROMOTIONS_END, 1)
    return before + after


def strip_codex_timestamps_payload(text):
    if CODEX_TIMESTAMPS_START not in text:
        return text
    if text.count(CODEX_TIMESTAMPS_START) != 1 or text.count(CODEX_TIMESTAMPS_END) != 1:
        raise ValueError("Unexpected Codex timestamp patch markers; refusing to modify this file.")
    before, rest = text.split(CODEX_TIMESTAMPS_START, 1)
    _, after = rest.split(CODEX_TIMESTAMPS_END, 1)
    return before + after


def codex_countdown_edits(js):
    identifier = r"[A-Za-z_$][\w$]*"
    pattern = re.compile(
        rf"(?<![\w$])(?P<title>{identifier})=(?P<date>{identifier})==null\?"
        rf"(?P<banner>{identifier})\.title:(?P=banner)\.title\.replaceAll\(`\{{time\}}`,(?P=date)\),"
        rf"(?P<description>{identifier})=(?P=date)==null\?(?P=banner)\.description:"
        rf"(?P=banner)\.description\.replaceAll\(`\{{time\}}`,(?P=date)\),"
    )
    matches = list(pattern.finditer(js))
    if not matches:
        return [codex_countdown_edit(js)]
    if len(matches) != 1:
        raise ValueError("Unsupported Codex extension build: usage-banner anchor is ambiguous.")
    match = matches[0]
    segment = js[match.end():match.end() + 8000]
    jsx = re.search(rf"\(0,({identifier})\.jsx\)\(`span`,\{{[^}}]*children:", segment)
    if jsx is None or "codex.rateLimitUpsellBanner.dismiss" not in segment:
        raise ValueError("Unsupported Codex extension build: usage-banner JSX anchor does not match.")
    banner = match.group("banner")
    edits = [(match.group(0),
        f'{match.group("title")}=scmToolkitUsageResetMessage({banner}.title,{banner}.reset_at,{jsx.group(1)}.jsx),'
        f'{match.group("description")}=scmToolkitUsageResetMessage({banner}.description,{banner}.reset_at,{jsx.group(1)}.jsx),')]
    weekly = re.compile(
        rf"(?<![\w$])(?P<display>{identifier})=(?P<date>{identifier})==null\?"
        rf"(?P<banner>{identifier})\.description:(?P=banner)\.description\.replace\(`\{{time\}}`,(?P=date)\),"
    )
    for match in weekly.finditer(js):
        before = js[max(0, match.start() - 4000):match.start()]
        reset = re.search(rf"({identifier}\.weeklyWindow\.resetsAt)==null\?null:", before)
        jsx = re.search(rf"\(0,({identifier})\.jsx\)", before)
        if reset is None or jsx is None:
            raise ValueError("Unsupported Codex extension build: weekly-reset anchor does not match.")
        edits.append((match.group(0),
            f'{match.group("display")}=scmToolkitUsageResetMessage({match.group("banner")}.description,{reset.group(1)},{jsx.group(1)}.jsx),'))
    edits.extend(codex_transcript_countdown_edits(js))
    return edits


def codex_transcript_countdown_edits(js):
    anchor = 'localConversation.usageLimit.upgrade.noReset'
    if anchor not in js:
        return []  # Older builds have no separate transcript usage-limit message.
    identifier = r"[A-Za-z_$][\w$]*"
    start = js.index(anchor)
    before = js[max(0, start - 3000):start]
    formatter = list(re.finditer(
        rf"(?P<display>{identifier})=(?P<reset>{identifier})==null\?null:"
        rf"{identifier}\({identifier},(?P=reset)\)", before))
    jsx = re.search(rf"\(0,({identifier})\.jsx\)", js[start:start + 5000])
    if len(formatter) != 1 or jsx is None:
        raise ValueError("Unsupported Codex extension build: transcript reset-time anchor does not match.")
    match = formatter[0]
    edits = [(match.group(0),
        f'{match.group("display")}={match.group("reset")}==null?null:'
        f'(0,{jsx.group(1)}.jsx)(`scm-toolkit-usage-reset-countdown`,'
        f'{{"reset-at":{match.group("reset")}}})')]
    messages = list(re.finditer(
        r"id:`localConversation\.usageLimit\.(?:upgrade|upgradeOrAddCredits|addCredits|retry)`,"
        r"defaultMessage:`[^`]*\bat \{resetDate\}[^`]*`", js))
    if not messages:
        raise ValueError("Unsupported Codex extension build: transcript usage-limit messages do not match.")
    for match in messages:
        original = match.group(0)
        replacement = original.replace('`,defaultMessage:', '.countdown`,defaultMessage:')
        replacement = replacement.replace('at {resetDate}', 'in {resetDate}')
        edits.append((original, replacement))
    return edits


def codex_rate_limit_script():
    """Inline the bundled Twilight PNG instead of relying on an external image host."""
    script = (CODEX_ASSETS / "rate-limit-controls.js").read_text()
    placeholder = '"__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__"'
    if script.count(placeholder) != 1:
        raise ValueError("Codex Twilight image placeholder must occur exactly once.")
    png = TWILIGHT_STOP_PNG.read_bytes()
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Codex Twilight sticker is not a PNG.")
    data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    return script.replace(placeholder, json.dumps(data_url))


def codex_transcript_compact_edits(js):
    """Only compact transcript usage-limit notices without a reset time."""
    pattern = re.compile(
        r'id:`(?P<id>localConversation\.usageLimit\.[A-Za-z.]+)`,'
        r'defaultMessage:`(?P<message>[^`]*)`'
    )
    edits = []
    for match in pattern.finditer(js):
        key, message = match['id'], match['message']
        if '{resetDate}' in message:
            continue
        if '.noReset' not in key and not re.search(
            r'\b(?:usage limit|try again later|rate limit)\b', message, re.I
        ):
            continue
        edits.append((match.group(0),
            f'id:`{key}.scmShort`,defaultMessage:`Rate limited`'))
    return edits


def strip_codex_dictation_payload(text):
    if CODEX_DICTATION_START not in text:
        return text
    if text.count(CODEX_DICTATION_START) != 1 or text.count(CODEX_DICTATION_END) != 1:
        raise ValueError("Unexpected Codex dictation patch markers; refusing to modify this file.")
    before, rest = text.split(CODEX_DICTATION_START, 1)
    _, after = rest.split(CODEX_DICTATION_END, 1)
    return before + after


def codex_countdown_edit(js):
    matches = []
    pattern = re.compile(
        r"(?P<display>[A-Za-z_$][\w$]*)=(?P<reset>[A-Za-z_$][\w$]*)==null\?null:"
        r"(?P<formatter>[A-Za-z_$][\w$]*)\((?P<intl>[A-Za-z_$][\w$]*),"
        r"(?P=reset),(?P<flag>[A-Za-z_$][\w$]*)\),"
    )
    title = "You’re out of Codex messages"
    for match in pattern.finditer(js):
        if title in js[match.end() : match.end() + 40_000]:
            matches.append(match)

    if len(matches) != 1:
        raise ValueError("Unsupported Codex extension build: reset-time anchor does not match.")

    match = matches[0]
    jsx_match = re.search(
        r"\(0,([A-Za-z_$][\w$]*)\.jsx\)\([^,]+,\{id:"
        r"`codex\.upsellBanner\.general\.title`,defaultMessage:"
        r"`You’re out of Codex messages`",
        js[match.end() : match.end() + 40_000],
    )
    if jsx_match is None:
        raise ValueError("Unsupported Codex extension build: JSX anchor does not match.")

    jsx = jsx_match.group(1)
    original = match.group(0)
    replacement = (
        f'{match.group("display")}={match.group("reset")}==null?null:'
        f'(0,{jsx}.jsx)(`scm-toolkit-usage-reset-countdown`,{{'
        f'"reset-at":{match.group("reset")}'
        '}),'
    )
    return original, replacement


def transform_codex(js, enabled=False, hide_promotions=False, hide_timestamps=False, hide_dictation=False, remove=False, short_model_labels=False, hide_reset_times=False, window_label="Codex"):
    if js.count(CODEX_LABELS_START) != js.count(CODEX_LABELS_END) or js.count(CODEX_LABELS_START) > 1:
        raise ValueError("Incomplete Codex model-label patch; refusing to overwrite it.")
    if CODEX_LABELS_START in js:
        before, rest = js.split(CODEX_LABELS_START, 1)
        _, after = rest.split(CODEX_LABELS_END, 1)
        js = before + after
    if js.count(CODEX_WINDOW_LABEL_START) != js.count(CODEX_WINDOW_LABEL_END) or js.count(CODEX_WINDOW_LABEL_START) > 1:
        raise ValueError("Incomplete Codex window-label patch; refusing to overwrite it.")
    if CODEX_WINDOW_LABEL_START in js:
        before, rest = js.split(CODEX_WINDOW_LABEL_START, 1)
        _, after = rest.split(CODEX_WINDOW_LABEL_END, 1)
        js = before + after
    js = codex_image_drop.transform(js, remove=remove)
    js = codex_recent_chats.transform(js, remove=remove)
    if js.count(CODEX_LIMIT_START) != js.count(CODEX_LIMIT_END) or js.count(CODEX_LIMIT_START) > 1:
        raise ValueError("Incomplete Codex limit-controls patch.")
    if CODEX_LIMIT_START in js:
        before, rest = js.split(CODEX_LIMIT_START, 1)
        payload, after = rest.split(CODEX_LIMIT_END, 1)
        js = before + after
        match = re.search(r'^/\* edits:(.*?) \*/$', payload, re.MULTILINE)
        if match is None:
            raise ValueError("Codex limit-controls metadata missing.")
        for original, replacement in reversed(json.loads(match[1])):
            if js.count(replacement) != 1:
                raise ValueError("Codex limit-controls patch changed; refusing to remove unrelated edits.")
            js = js.replace(replacement, original, 1)
    if js.count(CODEX_HIDE_RESET_START) != js.count(CODEX_HIDE_RESET_END) or js.count(CODEX_HIDE_RESET_START) > 1:
        raise ValueError("Incomplete Codex reset-time hiding patch; refusing to overwrite it.")
    if CODEX_HIDE_RESET_START in js:
        before, rest = js.split(CODEX_HIDE_RESET_START, 1)
        payload, after = rest.split(CODEX_HIDE_RESET_END, 1)
        js = before + after
        saved = re.search(r'^/\* edits:(.*?) \*/$', payload, re.MULTILINE)
        for original, replacement in reversed(json.loads(saved[1]) if saved else []):
            if js.count(replacement) != 1:
                raise ValueError('Codex reset-time patch changed; refusing to remove unrelated edits.')
            js = js.replace(replacement, original, 1)
    if CODEX_DICTATION_START in js:
        js = strip_codex_dictation_payload(js)
    if CODEX_TIMESTAMPS_START in js:
        js = strip_codex_timestamps_payload(js)
    if CODEX_PROMOTIONS_START in js:
        js = strip_codex_promotions_payload(js)

    installed = CODEX_START in js
    if installed:
        payload = js.split(CODEX_START, 1)[1].split(CODEX_END, 1)[0]
        saved = re.search(r"^/\* edit:(.*?) \*/$", payload, re.MULTILINE)
        if saved is None:
            raise ValueError("Installed Codex countdown patch is missing its edit metadata.")
        metadata = json.loads(saved.group(1))
        edits = metadata["edits"] if isinstance(metadata, dict) else [metadata]
        js = strip_codex_payload(js)
        for original, replacement in reversed(edits):
            if js.count(replacement) != 1:
                raise ValueError(
                    "Installed Codex countdown patch changed; refusing to remove unrelated edits."
                )
            js = js.replace(replacement, original, 1)

    if not remove and enabled:
        edits = codex_countdown_edits(js)
        for original, replacement in edits:
            if js.count(original) != 1:
                raise ValueError("Unsupported Codex extension build: reset-time anchor is ambiguous.")
            js = js.replace(original, replacement, 1)
        js = (
            js
            + CODEX_START
            + "/* edit:"
            + json.dumps({"edits": edits})
            + " */\n"
            + (CODEX_ASSETS / "countdown.js").read_text()
            + CODEX_END
        )

    if not remove and codex_bundle_matches(js):
        edits = codex_transcript_compact_edits(js)
        for original, replacement in edits:
            if js.count(original) != 1:
                raise ValueError("Unsupported Codex build: ambiguous transcript limit message.")
            js = js.replace(original, replacement, 1)
        js += (CODEX_LIMIT_START + "/* edits:" + json.dumps(edits) + " */\n"
               + codex_rate_limit_script()
               + CODEX_LIMIT_END)

    if not remove and hide_reset_times:
        js += (
            CODEX_HIDE_RESET_START
            + (CODEX_ASSETS / "hide-reset-times.js").read_text()
            + CODEX_HIDE_RESET_END
        )

    if not remove and hide_promotions:
        js += (
            CODEX_PROMOTIONS_START
            + (CODEX_ASSETS / "hide-promotions.js").read_text()
            + CODEX_PROMOTIONS_END
        )

    if not remove and hide_timestamps:
        js += (
            CODEX_TIMESTAMPS_START
            + (CODEX_ASSETS / "hide-chat-timestamps.js").read_text()
            + CODEX_TIMESTAMPS_END
        )

    if not remove and hide_dictation:
        js += (
            CODEX_DICTATION_START
            + (CODEX_ASSETS / "hide-dictation.js").read_text()
            + CODEX_DICTATION_END
        )

    if not remove and short_model_labels:
        js += CODEX_LABELS_START + (CODEX_ASSETS / "short-model-labels.js").read_text() + CODEX_LABELS_END

    if not remove and window_label != "Codex":
        # Use the manifest's already-validated, single-line custom label.
        label = codex_label._validate_label(window_label)
        script = (CODEX_ASSETS / "window-label.js").read_text().replace(
            "__SCM_TOOLKIT_CODEX_WINDOW_LABEL__", json.dumps(label, ensure_ascii=True)
        )
        js += CODEX_WINDOW_LABEL_START + script + CODEX_WINDOW_LABEL_END

    return js

BACKGROUND_GIT_START = '/* sweetiebot-background-commit:start */'
BACKGROUND_GIT_END = '/* sweetiebot-background-commit:end */'


def transform_git_background(source, remove=False):
    for start, end in ((BACKGROUND_GIT_START, BACKGROUND_GIT_END),
                       ('/* sweetiebot-background-push:start */', '/* sweetiebot-background-push:end */')):
        if source.count(start) != source.count(end) or source.count(start) > 1:
            raise ValueError('Incomplete background Git patch.')
        if start in source:
            before, remainder = source.split(start, 1)
            _, after = remainder.split(end, 1)
            source = before + after
    if remove:
        return source
    ident = r'[A-Za-z_$][\w$]*'
    pattern = re.compile(rf'async commit\(({ident}),({ident})=Object.create\(null\)\)\{{let ({ident})=\[\.\.\.this.indexGroup.resourceStates.map\(')
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError('Unsupported native Git staged commit lifecycle.')
    match = matches[0]
    message, options = match[1], match[2]
    api = re.search(rf'({ident})\.workspace.getConfiguration\("git",\1\.Uri.file\(this.root\)\)', source[match.end():match.end()+1800])
    if not api:
        raise ValueError('Unsupported native Git configuration API.')
    vscode = api[1]
    offset = source.index('{let ', match.start()) + 1
    injection = (BACKGROUND_GIT_START
        + f'if({vscode}.workspace.getConfiguration("scmToolkit",{vscode}.Uri.file(this.root)).get("durableBackgroundCommits",false)&&!{options}.amend&&!{options}.empty&&!this.rebaseCommit)'
        + '{let sweetiebotResult=await '
        + f'{vscode}.commands.executeCommand("sweetiebot.queueCommit",{vscode}.Uri.file(this.root),'
        + '{'
        + f'message:{message}??"",all:{options}.all,push:{options}.postCommitCommand===void 0?void 0:({options}.postCommitCommand==="push"||{options}.postCommitCommand==="git.push"),'
        + f'sign:{options}.signCommit,signoff:{options}.signoff,noVerify:{options}.noVerify'
        + '});if(sweetiebotResult?.queued||sweetiebotResult?.cancelled){'
        + 'if(sweetiebotResult.queued)this.inputBox.value=await this.getInputTemplate();return}}'
        + BACKGROUND_GIT_END)
    source = source[:offset] + injection + source[offset:]
    push = re.search(rf'async _push\(({ident}),({ident}),({ident})=!1,({ident})=!1,({ident}),({ident})=!1\)\{{', source)
    if push:
        remote, branch, upstream, tags, force, all_tags = push.groups()
        handoff = ('/* sweetiebot-background-push:start */'
            + f'if(!{tags}&&!{force}&&!{all_tags})'
            + '{let sweetiebotPush=await '
            + f'{vscode}.commands.executeCommand("sweetiebot.queuePush",{vscode}.Uri.file(this.root),'
            + '{' + f'remote:{remote},branch:{branch}'
            + '});if(sweetiebotPush?.queued)return;}'
            + '/* sweetiebot-background-push:end */')
        source = source[:push.end()] + handoff + source[push.end():]
    return source


def remove_legacy_branch_picker(js, css):
    # The predecessor picker owns the same widget hooks. Leaving its saved
    # anchors in comments can make a new install patch metadata instead of code.
    start, end = '/* studio-scm-branch-picker:start */', '/* studio-scm-branch-picker:end */'
    for source in (js, css):
        if source.count(start) != source.count(end) or source.count(start) > 1:
            raise ValueError('Incomplete legacy Studio branch picker patch.')
    if start not in js:
        return js, css
    before, rest = js.split(start, 1)
    payload, after = rest.split(end, 1)
    saved = re.search(r'^/\* edits:(.*?) \*/$', payload, re.MULTILINE)
    if not saved:
        raise ValueError('Legacy Studio branch picker is missing its edit metadata.')
    js = before + after
    for original, replacement in reversed(json.loads(saved.group(1))):
        if js.count(replacement) != 1:
            raise ValueError('Legacy Studio branch picker changed; refusing unrelated edits.')
        js = js.replace(replacement, original, 1)
    if start in css:
        before, rest = css.split(start, 1)
        _, after = rest.split(end, 1)
        css = before + after
    return js, css


def transform(js, css, remove=False, settings=None):
    installed = START in js
    if installed != (START in css):
        raise ValueError("Incomplete toolkit installation; refusing to overwrite it.")

    if installed:
        payload = js.split(START, 1)[1].split(END, 1)[0]
        saved = re.search(r"^/\* edits:(.*?) \*/$", payload, re.MULTILINE)
        previous = json.loads(saved.group(1)) if saved else edits()
        js, css = strip_payload(js), strip_payload(css)

        for edit in previous:
            original, replacement, expected_count = unpack_edit(edit)
            if js.count(replacement) != expected_count:
                raise ValueError(
                    "Installed toolkit patch changed; refusing to remove unrelated edits."
                )
            js = js.replace(replacement, original, expected_count)

    js, css = remove_legacy_branch_picker(js, css)

    if remove:
        return js, css

    settings = load_settings() if settings is None else settings
    runtime_settings = resolve_runtime_settings(settings)
    changes = edits(js, settings=settings)
    for edit in changes:
        original, replacement, expected_count = unpack_edit(edit)
        if js.count(original) != expected_count:
            raise ValueError("Unsupported VS Code build: SCM widget anchor does not match.")
        js = js.replace(original, replacement, expected_count)

    js += (
        START
        + "const scmToolkitSettings = "
        + json.dumps(runtime_settings, separators=(",", ":"))
        + ";\n"
        + "/* edits:"
        + json.dumps(changes)
        + " */\n"
        + (WORKBENCH_ASSETS / "picker.js").read_text()
        + "\n"
        + (WORKBENCH_ASSETS / "branch_strip.js").read_text()
        + "\n"
        + (WORKBENCH_ASSETS / "message_bar.js").read_text()
        + "\n"
        + (WORKBENCH_ASSETS / "codex_file_drag.js").read_text()
        + END
    )
    toolkit_css = (WORKBENCH_ASSETS / "picker.css").read_text()
    toolkit_css += "\n" + (WORKBENCH_ASSETS / "branch_strip.css").read_text()
    if settings.get("hideSCMProgress", True):
        toolkit_css += "\n" + (WORKBENCH_ASSETS / "hide_progress.css").read_text()
    if not settings["filledButtons"]:
        toolkit_css += "\n" + (WORKBENCH_ASSETS / "outlined_buttons.css").read_text()
    css += START + toolkit_css + END
    return js, css


def application_paths(app_path):
    app = app_path / "Contents/Resources/app"
    package = app / "package.json"
    version = json.loads(package.read_text())["version"]
    workbench = app / "out/vs/workbench"
    return version, [
        workbench / "workbench.desktop.main.js",
        workbench / "workbench.desktop.main.css",
    ]


def codex_bundle_matches(text):
    if CODEX_LIMIT_START in text or ('localConversation.usageLimit.' in text and 'defaultMessage:' in text):
        return True
    if codex_recent_chats.START in text or (codex_recent_chats.ANCHOR in text and 'defaultMessage:' in text):
        return True
    if CODEX_START in text or CODEX_PROMOTIONS_START in text or CODEX_TIMESTAMPS_START in text or CODEX_DICTATION_START in text:
        return True

    if CODEX_WINDOW_LABEL_START in text:
        return True
    if CODEX_LABELS_START in text or ('data-selected-reasoning-effort' in text and 'data-composer-navigation-target' in text):
        return True

    # Discover by feature, independently of compiler output and patch support.
    # Translation dictionaries contain the same IDs, but no defaultMessage.
    if ("You’re out of Codex messages" in text
            or ('codex.rateLimitUpsellBanner.dismiss' in text
                and ('defaultMessage:' in text or '.reset_at' in text))
            or ('dragCounterRef:' in text and re.search(r'addEventListener\([`\"\']dragenter[`\"\']', text))):
        return True

    return "Enable Fast mode" in text


def codex_bundle_paths(extension_path=None):
    if extension_path is None:
        extensions = Path.home() / ".vscode/extensions"
        candidates = sorted(extensions.glob("openai.chatgpt-*"), reverse=True)
    else:
        candidates = [extension_path]

    matches = []
    for candidate in candidates:
        assets = candidate / "webview/assets"
        if not assets.is_dir():
            continue
        for path in assets.glob("*.js"):
            text = path.read_text()
            if codex_bundle_matches(text) or codex_image_drop.START in text:
                matches.append(path)
    return sorted(matches)


def codex_bundle_path(extension_path=None):
    paths = codex_bundle_paths(extension_path)
    # Compatibility for callers needing one bundle: prefer the usage UI.
    return max(paths, key=lambda path: 'codex.rateLimitUpsellBanner.dismiss' in path.read_text(), default=None)

def write_pair(paths, new_contents, old_contents):
    written = []
    try:
        for path, content, original in zip(paths, new_contents, old_contents):
            written.append((path, original))
            path.write_text(content)
    except OSError:
        for path, original in written:
            try:
                path.write_text(original)
            except OSError:
                pass
        raise


def invalidate_extension_cache(app):
    """Discard only VS Code's manifest scan so the next reload sees new labels."""
    try:
        product = json.loads((app / 'Contents/Resources/app/product.json').read_text())
        name = product.get('nameShort')
        if not isinstance(name, str) or not name or Path(name).name != name or name in ('.', '..'):
            return
        cache = Path.home() / 'Library/Application Support' / name / 'CachedExtensions/user'
        if not cache.is_symlink() and cache.is_file():
            cache.unlink()
    except (OSError, ValueError) as error:
        print(f'Could not reset the VS Code extension manifest cache ({type(error).__name__}); another reload may be needed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app",
        type=Path,
        default=Path("/Applications/Visual Studio Code.app"),
        help="Path to the Visual Studio Code application bundle",
    )
    parser.add_argument("--uninstall", action="store_true", help="Remove the toolkit patch")
    parser.add_argument("--check", action="store_true", help="Validate without writing")
    parser.add_argument(
        "--configure",
        action="store_true",
        help="Configure in a local browser before installing",
    )
    parser.add_argument(
        "--codex-only",
        action="store_true",
        help="Only install or remove optional Codex webview customizations",
    )
    parser.add_argument(
        "--codex-extension",
        type=Path,
        help="Path to an OpenAI Codex VS Code extension directory",
    )
    parser.add_argument("--repair", action="store_true", help="Repair app patches and refresh companion tools")
    args = parser.parse_args()
    if args.repair and (args.uninstall or args.configure or args.codex_only):
        parser.error("--repair cannot be combined with --uninstall, --configure, or --codex-only")

    if args.configure and (args.uninstall or args.check or args.codex_only):
        parser.error("--configure cannot be combined with --uninstall, --check, or --codex-only")

    settings = load_settings()
    if args.configure:
        from configurator import run_configurator

        if not run_configurator(settings, action_label="Save and install"):
            print("Installation cancelled; no toolkit settings were changed.")
            return
        settings = load_settings()
    version, workbench_paths = application_paths(args.app)
    legacy_changed = not args.codex_only and workspace_search.remove_legacy_extensions(check=True)
    paths = [] if args.codex_only else workbench_paths
    old = [path.read_text() for path in paths]
    new = (
        []
        if args.codex_only
        else list(transform(*old, remove=args.uninstall, settings=settings))
    )
    wrapper_path = ai_wrapper_path()
    wrapper_changed = (
        False
        if args.codex_only
        else sync_ai_wrapper(
            remove=args.uninstall, check=True, destination=wrapper_path
        )
    )
    model_picker_path = ai_model_picker_path()
    model_picker_changed = (
        False
        if args.codex_only or args.repair
        else sync_model_picker(
            enabled=settings["aiModelPicker"],
            remove=args.uninstall,
            check=True,
            destination=model_picker_path,
        )
    )
    workspace_search_changed = (
        False
        if args.codex_only
        else workspace_search.sync_extension(
            remove=args.uninstall,
            check=True,
            settings=settings,
        )
    )

    if not args.codex_only:
        git_extension = args.app / 'Contents/Resources/app/extensions/git/dist/main.js'
        git_old = git_extension.read_text()
        paths.append(git_extension)
        old.append(git_old)
        new.append(transform_git_background(git_old, remove=args.uninstall))
        for browser_path, browser_old, browser_new in browser_pr.patch_files(args.app, remove=args.uninstall):
            paths.append(browser_path)
            old.append(browser_old)
            new.append(browser_new)
        for github_path, github_old, github_new in github_pr.patch_files(remove=args.uninstall):
            paths.append(github_path)
            old.append(github_old)
            new.append(github_new)

    label_patch = codex_label.patch_file(
        args.codex_extension,
        label=settings["codexWindowLabel"],
        remove=args.uninstall,
    )
    if label_patch is not None:
        label_path, label_old, label_new = label_patch
        paths.append(label_path)
        old.append(label_old)
        new.append(label_new)

    color_path = codex_colors.stylesheet_path(args.codex_extension)
    if color_path is not None:
        color_old = color_path.read_text()
        color_new = codex_colors.transform(color_old, settings, remove=args.uninstall)
        paths.append(color_path)
        old.append(color_old)
        new.append(color_new)
    elif any(settings.get(key) for key in codex_colors.APPEARANCE_SETTINGS):
        raise ValueError("The installed Codex composer stylesheet could not be identified.")

    for path, context_old, context_new in codex_context.patch_files(
        args.codex_extension, enabled=settings.get("codexCommitContext", False) and not args.uninstall
    ):
        paths.append(path)
        old.append(context_old)
        new.append(context_new)

    # Draft isolation runs even when read-only Codex commit context is disabled.
    # Compose with the context patch rather than overwriting its webview edits.
    try:
        draft_patches = codex_drafts.patch_files(
            args.codex_extension, enabled=not args.uninstall
        )
    except ValueError as error:
        if args.codex_only or not str(error).startswith('Unsupported Codex '):
            raise
        print(f"Warning: {error} Skipping optional Codex draft isolation.")
        draft_patches = []
    for draft_path, draft_old, draft_new in draft_patches:
        if draft_path in paths:
            index = paths.index(draft_path)
            draft_transform = (codex_drafts.transform_host if draft_path.name == 'extension.js'
                               else codex_drafts.transform_webview)
            new[index] = draft_transform(new[index], enabled=not args.uninstall)
        else:
            paths.append(draft_path)
            old.append(draft_old)
            new.append(draft_new)

    startup_patch = codex_startup.patch_file(args.codex_extension, remove=args.uninstall)
    if startup_patch is not None:
        startup_path, startup_old, startup_new = startup_patch
        if startup_path in paths:
            index = paths.index(startup_path)
            new[index] = codex_startup.transform(new[index], remove=args.uninstall)
        else:
            paths.append(startup_path)
            old.append(startup_old)
            new.append(startup_new)

    codex_paths = codex_bundle_paths(args.codex_extension)
    try:
        awake_patch = codex_keep_awake.patch_file(
            args.codex_extension, enabled=settings.get("codexKeepAwake", True), remove=args.uninstall
        )
    except ValueError as error:
        if args.codex_only or not str(error).startswith('Unsupported Codex build:'):
            raise
        print(f"Warning: {error} Skipping optional Codex keep-awake customization.")
        awake_patch = None
    if awake_patch is not None:
        awake_path, awake_old, awake_new = awake_patch
        if awake_path in paths:
            index = paths.index(awake_path)
            new[index] = codex_keep_awake.transform(
                new[index], settings.get("codexKeepAwake", True), args.uninstall
            )
        else:
            paths.append(awake_path)
            old.append(awake_old)
            new.append(awake_new)
    usage_pie = settings.get("codexUsagePieIndicator", False)
    hide_reset_times = settings.get("codexHideUsageResetTimes", False)
    for usage_path, usage_old, usage_new in codex_usage.patch_files(
        args.codex_extension,
        enabled=(settings["codexUsageResetCountdown"] or usage_pie or hide_reset_times) and not args.uninstall,
        hide_reset_times=hide_reset_times,
        pie_indicator=usage_pie,
        reset_countdown=settings["codexUsageResetCountdown"] and not hide_reset_times,
    ):
        paths.append(usage_path)
        old.append(usage_old)
        new.append(usage_new)

    # Clean the legacy source edits while retaining the requested native-control placement.
    inline_location = settings["codexInlineLocation"] and not args.uninstall
    clipboard_submit = settings["codexClipboardSubmit"] and not args.uninstall
    for composer_path, composer_old, composer_new in codex_composer.patch_files(
        args.codex_extension, inline=inline_location, paste_button=clipboard_submit
    ):
        if composer_path in paths:
            index = paths.index(composer_path)
            new[index] = codex_composer.transform_layout(
                new[index], inline_location, clipboard_submit,
                codex_composer.clipboard_module(composer_path) if clipboard_submit else None)
        else:
            paths.append(composer_path)
            old.append(composer_old)
            new.append(composer_new)

        index = paths.index(composer_path)
        new[index] = codex_composer.transform_placeholders(
            new[index], {} if args.uninstall else settings
        )

    should_find_codex = (
        settings["codexUsageResetCountdown"]
        or hide_reset_times
        or settings["codexHidePromotions"]
        or settings["codexHideChatTimestamps"]
        or settings["codexHideDictation"]
        or settings["codexShortModelLabels"]
        or settings["codexWindowLabel"] != "Codex"
        or args.uninstall
    )
    if not codex_paths and should_find_codex:
        message = "OpenAI Codex extension webview bundle was not found or is unsupported."
        if args.codex_only:
            raise ValueError(message)
        print(f"Warning: {message} Skipping optional Codex customizations.")
    for codex_path in codex_paths:
        existing_index = paths.index(codex_path) if codex_path in paths else None
        codex_old = new[existing_index] if existing_index is not None else codex_path.read_text()
        try:
            codex_new = transform_codex(
                codex_old,
                enabled=settings["codexUsageResetCountdown"] and not hide_reset_times and (
                    CODEX_START in codex_old or 'codex.rateLimitUpsellBanner.dismiss' in codex_old
                    or 'You’re out of Codex messages' in codex_old
                ),
                hide_reset_times=hide_reset_times,
                hide_promotions=settings["codexHidePromotions"],
                hide_timestamps=settings["codexHideChatTimestamps"],
                hide_dictation=settings["codexHideDictation"],
                short_model_labels=settings["codexShortModelLabels"],
                window_label=settings["codexWindowLabel"],
                remove=args.uninstall,
            )
        except ValueError as error:
            if (
                args.codex_only
                or CODEX_START in codex_old
                or CODEX_LIMIT_START in codex_old
                or CODEX_PROMOTIONS_START in codex_old
                or CODEX_TIMESTAMPS_START in codex_old
                or CODEX_DICTATION_START in codex_old
                or CODEX_LABELS_START in codex_old
                or CODEX_WINDOW_LABEL_START in codex_old
            ):
                raise
            print(f"Warning: {error} Skipping optional Codex customizations.")
        else:
            if existing_index is not None:
                new[existing_index] = codex_new
            else:
                paths.append(codex_path)
                old.append(codex_old)
                new.append(codex_new)

    if (
        old == list(new)
        and not wrapper_changed
        and not model_picker_changed
        and not workspace_search_changed
        and not legacy_changed
    ):
        if not args.check and not args.repair:
            invalidate_extension_cache(args.app)
        action = "not installed" if args.uninstall else "already up to date"
        print(f"SCM toolkit is {action} for VS Code {version}.")
        return

    if not args.check:
        if not args.codex_only:
            workspace_search.remove_legacy_extensions()
        if old != list(new):
            if old != [path.read_text() for path in paths]:
                raise RuntimeError("VS Code changed during validation; retry the command.")
            write_pair(paths, new, old)
        if not args.codex_only:
            sync_ai_wrapper(remove=args.uninstall, destination=wrapper_path)
            workspace_search.sync_extension(remove=args.uninstall, settings=settings)
        if not args.codex_only and not args.repair:
            sync_model_picker(
                enabled=settings["aiModelPicker"],
                remove=args.uninstall,
                destination=model_picker_path,
            )
        if workspace_search_changed or any(
            path.name == 'package.json' and previous != updated
            for path, previous, updated in zip(paths, old, new)
        ) or not args.repair:
            invalidate_extension_cache(args.app)

    if not args.check and not args.uninstall and not args.codex_only:
        persist_message_bar_layout(settings)
    action = "Validated" if args.check else "Removed" if args.uninstall else "Installed"
    target = "Codex customizations" if args.codex_only else "SCM toolkit"
    print(f"{action} {target} for VS Code {version}. Reload VS Code to apply the change.")
    if not args.codex_only and not args.repair:
        if args.uninstall:
            print("Clear VS Code git.path if it still points to the removed SCM toolkit wrapper.")
        else:
            print(f"AI commit wrapper: {wrapper_path}")
            if settings["aiModelPicker"]:
                print(f"AI model picker: {model_picker_path}")
            else:
                print("AI model picker: disabled by scm-toolkit.ai-model-picker")
            print(f"Workspace Search extension: {workspace_search.extension_destination()}")
            print(
                "Set VS Code git.path to that absolute path and "
                "git.useEditorAsCommitInput to true."
            )


if __name__ == "__main__":
    main()
