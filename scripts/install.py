#!/usr/bin/env python3
"""Apply, validate, or remove the custom VS Code SCM toolkit patch."""

import argparse
import json
import os
import re
import workspace_search
import codex_colors
import codex_composer
import codex_usage
import codex_context
import codex_keep_awake
import codex_image_drop
import codex_recent_chats
import github_pr
from pathlib import Path
from toolkit_settings import DEFAULT_SETTINGS, load_settings, read_git_bool, read_git_string
from branch_names import resolve_runtime_settings

HERE = Path(__file__).resolve().parent
WORKBENCH_ASSETS = HERE.parent / "assets/workbench"
CODEX_ASSETS = HERE.parent / "assets/codex"
START = '\n/* scm-toolkit:start */\n'
END = '\n/* scm-toolkit:end */\n'
CODEX_START = '\n/* scm-toolkit-codex-countdown:start */\n'
CODEX_END = '\n/* scm-toolkit-codex-countdown:end */\n'
CODEX_PROMOTIONS_START = '\n/* scm-toolkit-codex-promotions:start */\n'
CODEX_PROMOTIONS_END = '\n/* scm-toolkit-codex-promotions:end */\n'
CODEX_TIMESTAMPS_START = '\n/* scm-toolkit-codex-timestamps:start */\n'
CODEX_TIMESTAMPS_END = '\n/* scm-toolkit-codex-timestamps:end */\n'
CODEX_DICTATION_START = '\n/* scm-toolkit-codex-dictation:start */\n'
CODEX_DICTATION_END = '\n/* scm-toolkit-codex-dictation:end */\n'

CODEX_LABELS_START = '\n/* scm-toolkit-codex-model-labels:start */\n'
CODEX_LABELS_END = '\n/* scm-toolkit-codex-model-labels:end */\n'


def ai_wrapper_path():
    configured = os.environ.get(
        "SCM_TOOLKIT_AI_WRAPPER_PATH", "~/.local/bin/scm-toolkit-git"
    )
    return Path(configured).expanduser()


def sync_ai_wrapper(remove=False, check=False, destination=None):
    destination = Path(destination) if destination is not None else ai_wrapper_path()
    files = [
        (HERE / "ai_commit.py", destination),
        (HERE / "post_commit_spellcheck.py", destination.with_name(destination.name + "-spellcheck.py")),
    ]
    # Validate both destinations before changing either one.
    for _, target in files:
        if not remove and target.is_symlink():
            raise RuntimeError(f"Refusing to overwrite symlinked AI wrapper: {target}")
    changed = False
    for source, target in files:
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


def browser_chatgpt_home_edits(js):
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
    replacement = (
        f'{match.group("prefix")},url:{match.group("options")}?.viewState?.url'
        f'??"https://chatgpt.com/"{match.group("suffix")}'
    )
    return [(original, replacement)]


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

    if js is not None and settings and settings.get("browserChatgptHome"):
        changes.extend(browser_chatgpt_home_edits(js))

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


def transform_codex(js, enabled=False, hide_promotions=False, hide_timestamps=False, hide_dictation=False, remove=False, short_model_labels=False):
    if js.count(CODEX_LABELS_START) != js.count(CODEX_LABELS_END) or js.count(CODEX_LABELS_START) > 1:
        raise ValueError("Incomplete Codex model-label patch; refusing to overwrite it.")
    if CODEX_LABELS_START in js:
        before, rest = js.split(CODEX_LABELS_START, 1)
        _, after = rest.split(CODEX_LABELS_END, 1)
        js = before + after
    js = codex_image_drop.transform(js, remove=remove)
    js = codex_recent_chats.transform(js, remove=remove)
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
            + (CODEX_ASSETS / "codex-countdown.js").read_text()
            + CODEX_END
        )

    if not remove and hide_promotions:
        js += (
            CODEX_PROMOTIONS_START
            + (CODEX_ASSETS / "codex-hide-promotions.js").read_text()
            + CODEX_PROMOTIONS_END
        )

    if not remove and hide_timestamps:
        js += (
            CODEX_TIMESTAMPS_START
            + (CODEX_ASSETS / "codex-hide-chat-timestamps.js").read_text()
            + CODEX_TIMESTAMPS_END
        )

    if not remove and hide_dictation:
        js += (
            CODEX_DICTATION_START
            + (CODEX_ASSETS / "codex-hide-dictation.js").read_text()
            + CODEX_DICTATION_END
        )

    if not remove and short_model_labels:
        js += CODEX_LABELS_START + (CODEX_ASSETS / "codex-short-model-labels.js").read_text() + CODEX_LABELS_END

    return js

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
        + END
    )
    toolkit_css = (WORKBENCH_ASSETS / "picker.css").read_text()
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
    if codex_recent_chats.START in text or (codex_recent_chats.ANCHOR in text and 'defaultMessage:' in text):
        return True
    if CODEX_START in text or CODEX_PROMOTIONS_START in text or CODEX_TIMESTAMPS_START in text or CODEX_DICTATION_START in text:
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
    args = parser.parse_args()

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
        if args.codex_only
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
        for github_path, github_old, github_new in github_pr.patch_files(remove=args.uninstall):
            paths.append(github_path)
            old.append(github_old)
            new.append(github_new)

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
    for usage_path, usage_old, usage_new in codex_usage.patch_files(
        args.codex_extension,
        enabled=settings["codexUsageResetCountdown"] and not args.uninstall,
    ):
        paths.append(usage_path)
        old.append(usage_old)
        new.append(usage_new)

    # Clean the legacy source edits while retaining the requested native-control placement.
    inline_location = settings["codexInlineLocation"] and not args.uninstall
    for composer_path, composer_old, composer_new in codex_composer.patch_files(args.codex_extension, inline=inline_location):
        if composer_path in paths:
            index = paths.index(composer_path)
            new[index] = codex_composer.transform_layout(new[index], inline_location)
        else:
            paths.append(composer_path)
            old.append(composer_old)
            new.append(composer_new)

    should_find_codex = (
        settings["codexUsageResetCountdown"]
        or settings["codexHidePromotions"]
        or settings["codexHideChatTimestamps"]
        or settings["codexHideDictation"]
        or settings["codexShortModelLabels"]
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
                enabled=settings["codexUsageResetCountdown"] and (
                    CODEX_START in codex_old or 'codex.rateLimitUpsellBanner.dismiss' in codex_old
                    or 'You’re out of Codex messages' in codex_old
                ),
                hide_promotions=settings["codexHidePromotions"],
                hide_timestamps=settings["codexHideChatTimestamps"],
                hide_dictation=settings["codexHideDictation"],
                short_model_labels=settings["codexShortModelLabels"],
                remove=args.uninstall,
            )
        except ValueError as error:
            if (
                args.codex_only
                or CODEX_START in codex_old
                or CODEX_PROMOTIONS_START in codex_old
                or CODEX_TIMESTAMPS_START in codex_old
                or CODEX_DICTATION_START in codex_old
                or CODEX_LABELS_START in codex_old
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
    ):
        action = "not installed" if args.uninstall else "already up to date"
        print(f"SCM toolkit is {action} for VS Code {version}.")
        return

    if not args.check:
        if old != list(new):
            if old != [path.read_text() for path in paths]:
                raise RuntimeError("VS Code changed during validation; retry the command.")
            write_pair(paths, new, old)
        if not args.codex_only:
            sync_ai_wrapper(remove=args.uninstall, destination=wrapper_path)
            sync_model_picker(
                enabled=settings["aiModelPicker"],
                remove=args.uninstall,
                destination=model_picker_path,
            )
            workspace_search.sync_extension(
                remove=args.uninstall,
                settings=settings,
            )

    action = "Validated" if args.check else "Removed" if args.uninstall else "Installed"
    target = "Codex customizations" if args.codex_only else "SCM toolkit"
    print(f"{action} {target} for VS Code {version}. Reload VS Code to apply the change.")
    if not args.codex_only:
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
