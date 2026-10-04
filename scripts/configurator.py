#!/usr/bin/env python3
"""Local, dependency-free web configurator for the SCM toolkit."""

from __future__ import annotations

import html
import json
import math
import re
import secrets
import shutil
import subprocess
import threading
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from toolkit_settings import load_settings, VSCODE_SETTINGS
from codex_colors import validate_color
from branch_names import load_catalog, merge_catalog, parse_imported_packs, parse_name_list, parse_pack_id_list
from chatgpt_integration import import_pgp_secret_key, sync_codex_instructions


OLLAMA_URL = "http://127.0.0.1:11434"
MAX_FORM_BYTES = 512 * 1024


@dataclass(frozen=True)
class Setting:
    name: str
    git_key: str
    label: str
    description: str
    section: str
    kind: str = "bool"
    choices: tuple[str, ...] = ()
    minimum: float | None = None
    maximum: float | None = None


SETTINGS = (
    Setting("branchPicker", "scm-toolkit.branch-picker", "Branch picker", "Show the current branch in the commit-message row.", "Source control"),
    Setting("ponyBranch", "scm-toolkit.pony-branch", "Random branch button", "Create a freshly synced branch using the configured branch-name pool.", "Source control"),
    Setting("shortPlaceholder", "scm-toolkit.short-placeholder", "Short message placeholder", "Use Message instead of the longer built-in placeholder.", "Source control"),
    Setting("commitButtonLabel", "scm-toolkit.commit-button-label", "Commit button label", "Text shown on the primary Source Control commit action. Leave blank to keep VS Code's label.", "Source control", "text"),
    Setting("sourceControlLabel", "scm-toolkit.source-control-label", "Source Control label", "Override the Source Control view label shown in the app bar.", "Source control", "text"),
    Setting("openPanelOnStartup", "scm-toolkit.open-panel-on-startup", "Open Sweetie Bot on startup", "Open Sweetie Bot / Source Control automatically when each VS Code window starts.", "Startup"),
    Setting("filledButtons", "scm-toolkit.filled-buttons", "Accent-filled buttons", "Fill the branch and Commit controls with the theme accent instead of outlining them.", "Source control"),
    Setting("commitAndPush", "scm-toolkit.commit-and-push", "Commit and push checkbox", "Show the control backed by git.postCommitCommand.", "Source control"),
    Setting("branchCleanup", "scm-toolkit.branch-cleanup", "Branch cleanup", "Show guarded local-branch cleanup controls.", "Source control"),
    Setting("autocompleteToggle", "scm-toolkit.autocomplete-toggle", "Autocomplete toggle", "Show the inline-suggestion switch in the SCM message row.", "Source control"),
    Setting("autoPublishToggle", "scm-toolkit.auto-publish-toggle", "Auto-publish toggle", "Show the cloud control that publishes newly selected local branches to the configured remote.", "Source control"),
    Setting("autoPublishNewBranches", "scm-toolkit.auto-publish-new-branches", "Automatically publish new branches", "Publish newly selected local branches to the configured remote. Saved as your VS Code user preference; the cloud control reflects this setting.", "Source control"),
    Setting("automaticBranchCleanup", "scm-toolkit.automatic-branch-cleanup", "Automatically clean merged branches", "Check for merged branches on startup and every ten minutes, and remove eligible local branches.", "Source control"),
    Setting("hideSCMProgress", "scm-toolkit.hide-scm-progress", "Hide Source Control progress bar", "Hide the progress animation during Git operations and background refreshes.", "Source control"),
    Setting("inlineSuggestions", "scm-toolkit.inline-suggestions", "Inline suggestions", "Enable inline suggestions, including in the commit-message editor.", "Source control"),
    Setting("postCommitAction", "scm-toolkit.post-commit-action", "After committing", "Choose whether commits automatically push or sync with the remote.", "Source control", "select", ("none", "push", "sync")),
    Setting("codexCoauthor", "scm-toolkit.codex-coauthor", "Codex co-author button", "Show the attributed commit action.", "Source control"),
    Setting("codexCommitContext", "scm-toolkit.codex-commit-context", "Local commit messages from Codex text", "When the co-author commit message is blank, use this window's current conversation and staged changes with local Ollama. Codex keeps running.", "Source control"),
    Setting("codexKeepAwake", "scm-toolkit.codex-keep-awake", "Keep awake while Codex works", "Prevent idle sleep on macOS while Codex tasks are running. The display can still turn off. Enabled by default; VS Code's Codex Keep Awake setting can override it.", "Codex"),
    Setting("hideOutgoingSyncCount", "scm-toolkit.hide-outgoing-sync-count", "Hide outgoing count", "Remove the outgoing commit count from Sync.", "Source control"),
    Setting("blankStateRefresh", "scm-toolkit.blank-state-refresh", "Refresh blank repositories", "Refresh clean repositories so their first new change appears quickly.", "Source control"),
    Setting("autoPullClean", "scm-toolkit.auto-pull-clean", "Automatically pull clean branches", "Fast-forward clean branches when their upstream is ahead, independently of blank-state refresh.", "Source control"),
    Setting("graphOpenWorkingFile", "scm-toolkit.graph-open-working-file", "Open graph files from working tree", "Make Source Control Graph Open File target the checked-out working-tree file instead of the selected commit snapshot.", "Source control"),
    Setting("cmdClickCloseOthers", "scm-toolkit.cmd-click-close-others", "Cmd-click closes other tabs", "Hold Command while clicking a tab's X to keep that tab open and close the other editors in its group.", "Browser"),
    Setting("browserChatgptHome", "scm-toolkit.browser-chatgpt-home", "ChatGPT for blank browser tabs", "Open blank Integrated Browser tabs at https://chatgpt.com/ while preserving explicit URLs.", "Browser"),
    Setting("workspaceSearchActivityBar", "scm-toolkit.workspace-search-activity-bar", "Standalone Activity Bar", "Move Workspace Search into its own Activity Bar container instead of the Source Control view.", "Workspace Search"),
    Setting("workspaceSearchLabel", "scm-toolkit.workspace-search-label", "Search label", "Label for the Workspace Search panel and its standalone Activity Bar container.", "Workspace Search", "text"),
    Setting("workspaceSearchEmbeddingModel", "scm-toolkit.workspace-search-embedding-model", "Search embedding model", "Turns workspace passages into searchable meaning. Choose an embedding model, separate from chat models.", "Workspace Search", "model"),
    Setting("workspaceSearchAskOllama", "scm-toolkit.workspace-search-ask-ollama", "Ask Ollama", "Show the Ask Ollama action in EFS search results.", "Workspace Search"),
    Setting("workspaceSearchChatModel", "scm-toolkit.workspace-search-chat-model", "Ask Ollama chat model", "Ollama chat model used by Ask Ollama. Required when Ask Ollama is enabled.", "Workspace Search", "optional_model"),
    Setting("workspaceSearchOllamaUrl", "scm-toolkit.workspace-search-ollama-url", "Search Ollama server", "Loopback URL of the Ollama server used for workspace search.", "Workspace Search", "url"),
    Setting("workspaceSearchMode", "scm-toolkit.workspace-search-mode", "Search ranking", "Default ranking mode for search results.", "Workspace Search", "select", ("hybrid", "semantic", "exact")),
    Setting("workspaceSearchAutoReindex", "scm-toolkit.workspace-search-auto-reindex", "Automatically refresh search index", "Refresh the workspace search index every two minutes.", "Workspace Search"),
    Setting("workspaceSearchResultLimit", "scm-toolkit.workspace-search-result-limit", "Search result limit", "Maximum number of result passages shown.", "Workspace Search", "integer", minimum=1, maximum=100),
    Setting("workspaceSearchMaxFiles", "scm-toolkit.workspace-search-max-files", "Search file limit", "Maximum number of workspace files considered for indexing.", "Workspace Search", "integer", minimum=1, maximum=50000),
    Setting("workspaceSearchMaxFileSizeMB", "scm-toolkit.workspace-search-max-file-size-mb", "Maximum indexed file size (MB)", "Maximum file size indexed directly.", "Workspace Search", "number", minimum=0.1, maximum=100),
    Setting("workspaceSearchExclude", "scm-toolkit.workspace-search-exclude", "Search exclusions", "Glob of paths excluded from workspace indexing. Leave blank to use no exclusions.", "Workspace Search", "optional_text"),
    Setting("defaultBranch", "scm-toolkit.default-branch", "Default branch", "Protected branch and pull-request base.", "Repository", "text"),
    Setting("remote", "scm-toolkit.remote", "Git remote", "Remote used for branch checks and repository discovery.", "Repository", "text"),
    Setting("branchNameDisabledPacks", "scm-toolkit.branch-name-disabled-packs", "Name packs", "Enable or disable built-in and imported branch-name packs.", "Branch names", "packs"),
    Setting("branchCustomNames", "scm-toolkit.branch-custom-names", "Custom names", "Add your own lowercase branch names, one per line.", "Branch names", "names"),
    Setting("branchNameImports", "scm-toolkit.branch-name-imports", "Imported packs", "Paste third-party packs as JSON using id, label, description, and names.", "Branch names", "imports"),
    Setting("postCommitSpellcheck", "scm-toolkit.post-commit-spellcheck", "Post-commit Markdown spellcheck", "After an automatic commit, propose corrections to changed Markdown prose as unstaged edits for review. Use ASCII punctuation. Off by default.", "Ollama"),
    Setting("aiCommit", "scm-toolkit.ai-commit", "AI commit titles", "Generate commit messages through the local Ollama service.", "Ollama"),
    Setting("spellcheckManualCommit", "scm-toolkit.spellcheck-manual-commit", "Spellcheck manual commit messages", "Use local Ollama to correct manually entered commit messages.", "Ollama"),
    Setting("aiDefaultBranchDescription", "scm-toolkit.ai-default-branch-description", "Default-branch descriptions", "Add a short description when generating commits on the default branch.", "Ollama"),
    Setting("aiModelPicker", "scm-toolkit.ai-model-picker", "Model picker command", "Install the separate model-selection helper.", "Ollama"),
    Setting("aiCommitModel", "scm-toolkit.ai-commit-model", "Normal model", "Ollama model used when memory is available.", "Ollama", "model"),
    Setting("aiCommitLowMemoryModel", "scm-toolkit.ai-commit-low-memory-model", "Low-memory model", "Smaller Ollama model used below the memory threshold.", "Ollama", "model"),
    Setting("aiLowMemoryGiB", "scm-toolkit.ai-low-memory-gib", "Low-memory threshold (GiB)", "Available-memory threshold for selecting the smaller model.", "Ollama", "number"),
    Setting("mcpPullRequest", "scm-toolkit.mcp-pull-request", "Pull-request button", "Open ChatGPT in the Integrated Browser with a prompt explaining the current branch's intent and effects.", "Pull requests"),
    Setting("mcpPrServer", "scm-toolkit.mcp-pr-server", "Pull-request MCP server", "Configured MCP server name for pull-request integrations.", "Pull requests", "text"),
    Setting("mcpPrTool", "scm-toolkit.mcp-pr-tool", "Pull-request MCP tool", "Configured MCP tool name for pull-request integrations.", "Pull requests", "text"),
    Setting("codexUsageResetCountdown", "scm-toolkit.codex-usage-reset-countdown", "Codex reset countdown", "Show the live usage-reset countdown in Codex limit banners.", "Codex"),
    Setting("codexHidePromotions", "scm-toolkit.codex-hide-promotions", "Hide Codex promotions", "Hide promotional panels in Codex.", "Codex"),
    Setting("codexShortModelLabels", "scm-toolkit.codex-short-model-labels", "Short model labels", "Shorten the active model display: remove GPT, use Med for Medium, Low for Light, and Uber for Extra high.", "Codex"),
    Setting("codexHideAccessLabel", "scm-toolkit.codex-hide-access-label", "Hide access label", "Show only the icon for the Codex access control, hiding labels such as Full access.", "Codex"),
    Setting("codexSendBackground", "scm-toolkit.codex-send-background", "Send button background", "Hex color for the Codex send button. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexSendForeground", "scm-toolkit.codex-send-foreground", "Send button icon", "Hex color for the Codex send icon. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexComposerLabelColor", "scm-toolkit.codex-composer-label-color", "Composer label text", "Hex color for Full access and Work locally controls. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexDropAccent", "scm-toolkit.codex-drop-accent", "Image drop accent", "Hex color for the drop highlight, border, and attachment prompt. Leave blank to use the theme.", "Codex", "color"),
    Setting("chatgptCustomInstructions", "scm-toolkit.chatgpt-custom-instructions", "Codex personalization", "Keep a local copy of your ChatGPT web instructions and mirror them into the global personalization used by the Codex VS Code extension.", "Codex", "textarea"),
    Setting("codexHideDictation", "scm-toolkit.codex-hide-dictation", "Hide dictation button", "Hide the microphone dictation control in Codex chat.", "Codex"),
    Setting("chatgptWebCodexCoauthor", "scm-toolkit.chatgpt-web-codex-coauthor", "Codex Web co-author", "Require the Codex Web co-author trailer on Git commits made through web or GitHub tools.", "Codex"),
    Setting("codexHideChatTimestamps", "scm-toolkit.codex-hide-chat-timestamps", "Hide chat timestamps", "Hide standalone date/time separators inside Codex conversations.", "Codex"),
)


def fetch_ollama_models() -> tuple[list[str], str]:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"{OLLAMA_URL}/api/tags", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return [], "Ollama was not detected at 127.0.0.1:11434. You can still enter model tags manually."

    models = set()
    for item in payload.get("models", []):
        for key in ("name", "model"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                models.add(value.strip())
    names = sorted(models)
    if names:
        return names, f"Detected {len(names)} local Ollama model{'s' if len(names) != 1 else ''}."
    return [], "Ollama is running locally, but it reported no installed models."


def model_tag(value: str) -> str:
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", value):
        raise ValueError("Enter a valid Ollama model tag.")
    return value


def ollama_request(endpoint: str, payload: dict, timeout: int = 30):
    request = urllib.request.Request(
        OLLAMA_URL + endpoint, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout)


def validate_models(settings: dict) -> None:
    models, status = fetch_ollama_models()
    installed = {name if ":" in name.rsplit("/", 1)[-1] else name + ":latest" for name in models}
    required = ["workspaceSearchEmbeddingModel"]
    if settings.get("workspaceSearchAskOllama"):
        required.append("workspaceSearchChatModel")
    if settings.get("aiCommit"):
        required.extend(["aiCommitModel", "aiCommitLowMemoryModel"])
    labels = {setting.name: setting.label for setting in SETTINGS}
    for key in required:
        name = model_tag(str(settings[key]))
        normalized = name if ":" in name.rsplit("/", 1)[-1] else name + ":latest"
        if normalized not in installed:
            raise ValueError(f"{labels[key]} ({name}) is not installed. Use its Download button before saving. {status}")
    name = str(settings["workspaceSearchEmbeddingModel"])
    try:
        with ollama_request("/api/show", {"model": name}) as response:
            info = json.loads(response.read())
    except Exception as error:
        raise ValueError(f"Could not check the search embedding model: {error}") from error
    if "embedding" not in info.get("capabilities", []):
        raise ValueError(f"{name} does not support embeddings. Choose an embedding model such as qwen3-embedding:0.6b.")


def parse_submission(values: dict[str, list[str]]) -> dict[str, bool | str]:
    parsed: dict[str, bool | str] = {}

    imports = parse_imported_packs(values.get("branchNameImports", ["[]"])[0])
    catalog = merge_catalog(load_catalog(), imports)
    known_ids = {str(pack["id"]) for pack in catalog["packs"]}
    rendered_ids = set(values.get("branchNameKnownPack", []))
    enabled_ids = set(values.get("branchNamePack", []))
    unknown_enabled = enabled_ids - known_ids
    if unknown_enabled:
        raise ValueError(f"Unknown branch-name pack: {sorted(unknown_enabled)[0]}")

    disabled = sorted((rendered_ids - enabled_ids) & known_ids)
    parsed["branchNameDisabledPacks"] = ",".join(disabled)
    parsed["branchCustomNames"] = ",".join(
        parse_name_list(values.get("branchCustomNames", [""])[0])
    )
    parsed["branchNameImports"] = json.dumps(imports, separators=(",", ":"))

    for setting in SETTINGS:
        if setting.kind in {"packs", "names", "imports"}:
            continue
        if setting.kind == "bool":
            parsed[setting.name] = setting.name in values
            continue

        raw_value = values.get(setting.name, [""])[0]
        if setting.kind == "color":
            parsed[setting.name] = validate_color(raw_value)
            continue
        if setting.kind == "textarea":
            if "\x00" in raw_value:
                raise ValueError(f"{setting.label} contains an invalid null byte.")
            parsed[setting.name] = raw_value.strip()
            continue

        value = raw_value.strip()
        if setting.kind == "optional_model":
            if "\x00" in value or "\n" in value or "\r" in value:
                raise ValueError(f"{setting.label} must fit on one line.")
            parsed[setting.name] = value
            continue
        if setting.kind == "select":
            if value not in setting.choices:
                raise ValueError(f"Choose a valid {setting.label.lower()}.")
            parsed[setting.name] = value
            continue
        if setting.kind == "optional_text":
            if "\x00" in value or "\n" in value or "\r" in value:
                raise ValueError(f"{setting.label} must fit on one line.")
            parsed[setting.name] = value
            continue
        if not value:
            raise ValueError(f"{setting.label} cannot be empty.")
        if "\x00" in value or "\n" in value or "\r" in value:
            raise ValueError(f"{setting.label} must fit on one line.")
        if setting.kind in {"number", "integer"}:
            try:
                number = float(value)
                if not math.isfinite(number) or number <= 0:
                    raise ValueError
            except ValueError as error:
                raise ValueError(f"{setting.label} must be greater than zero.") from error
            if setting.kind == "integer" and not number.is_integer():
                raise ValueError(f"{setting.label} must be a whole number.")
            if ((setting.minimum is not None and number < setting.minimum)
                    or (setting.maximum is not None and number > setting.maximum)):
                raise ValueError(f"{setting.label} must be between {setting.minimum} and {setting.maximum}.")
        if setting.kind == "url":
            url = urllib.parse.urlparse(value)
            if url.scheme not in {"http", "https"} or url.hostname not in {"localhost", "127.0.0.1", "::1"} or url.username or url.password:
                raise ValueError(f"{setting.label} must be a loopback HTTP URL.")
        parsed[setting.name] = value
    if parsed.get("workspaceSearchAskOllama") and not parsed.get("workspaceSearchChatModel"):
        raise ValueError("Ask Ollama requires a chat model.")
    return parsed


def save_settings(settings: dict[str, bool | str]) -> None:
    git = shutil.which("git")
    if not git:
        raise RuntimeError("Git was not found on PATH.")

    previous: dict[str, str | None] = {}
    for setting in SETTINGS:
        result = subprocess.run(
            [git, "config", "--global", "--get", setting.git_key],
            capture_output=True,
            text=True,
        )
        if result.returncode not in (0, 1):
            raise RuntimeError(result.stderr.strip() or f"Unable to read {setting.git_key}")
        previous[setting.git_key] = result.stdout.rstrip("\n") if result.returncode == 0 else None

    written: list[Setting] = []
    try:
        for setting in SETTINGS:
            value = settings[setting.name]
            serialized = "true" if value is True else "false" if value is False else str(value)
            result = subprocess.run(
                [git, "config", "--global", "--replace-all", setting.git_key, serialized],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or f"Unable to write {setting.git_key}")
            written.append(setting)
    except Exception:
        for setting in reversed(written):
            old_value = previous[setting.git_key]
            args = [git, "config", "--global"]
            if old_value is None:
                args += ["--unset-all", setting.git_key]
            else:
                args += ["--replace-all", setting.git_key, old_value]
            subprocess.run(args, capture_output=True, text=True)
        raise


def _pack_controls(current: dict[str, object]) -> str:
    disabled = set(parse_pack_id_list(current.get("branchNameDisabledPacks", "")))
    raw_imports = current.get("branchNameImports", "[]")
    try:
        imports = parse_imported_packs(raw_imports)
        catalog = merge_catalog(load_catalog(), imports)
    except ValueError:
        catalog = load_catalog()

    controls = []
    for pack in catalog["packs"]:
        pack_id = str(pack["id"])
        checked = "" if pack_id in disabled else " checked"
        description = str(pack.get("description", ""))
        count = len(pack["names"])
        detail = f"{description} {count} name{'s' if count != 1 else ''}.".strip()
        escaped_id = html.escape(pack_id, quote=True)
        controls.append(
            f'<input type="hidden" name="branchNameKnownPack" value="{escaped_id}">'
            f'<label class="pack-card" title="{html.escape(detail, quote=True)}">'
            f'<input type="checkbox" name="branchNamePack" value="{escaped_id}"{checked}>'
            f'<span><strong>{html.escape(str(pack["label"]))}</strong>'
            f'<small>{count} names</small></span></label>'
        )
    return (
        '<fieldset class="pack-picker"><legend>Name bundles</legend>'
        '<p>Choose the bundles to draw branch names from.</p>'
        '<div class="pack-toolbar"><input type="search" id="pack-search" '
        'aria-label="Find name bundles" placeholder="Find a bundle…">'
        '<output id="pack-count" aria-live="polite"></output></div>'
        '<div class="pack-grid">' + "".join(controls) + '</div>'
        '<p id="pack-empty" hidden>No matching bundles.</p></fieldset>'
    )


def _setting_control(setting: Setting, current: object) -> str:
    label = html.escape(setting.label)
    description = html.escape(setting.description)
    name = html.escape(setting.name, quote=True)
    if setting.kind == "bool":
        checked = " checked" if current is True else ""
        return (
            '<label class="setting toggle-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<input type="checkbox" name="{name}" value="true"{checked}>'
            '<span class="toggle" aria-hidden="true"></span></label>'
        )

    if setting.kind == "packs":
        return ""

    if setting.kind == "names":
        value = "\n".join(parse_name_list(current))
        return (
            '<label class="setting textarea-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<textarea name="{name}" rows="6" spellcheck="false" '
            f'placeholder="rainy-day&#10;my-oc">{html.escape(value)}</textarea></label>'
        )

    if setting.kind == "textarea":
        return (
            '<label class="setting textarea-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<textarea name="{name}" rows="8" spellcheck="true">{html.escape(str(current or ""))}</textarea></label>'
        )

    if setting.kind == "imports":
        raw = str(current or "[]")
        try:
            value = json.dumps(parse_imported_packs(raw), indent=2)
        except ValueError:
            value = raw
        return (
            '<label class="setting textarea-row">'
            f'<span><strong>{label}</strong><small>{description} '
            'Example: [{"id":"friends","label":"Friends","names":["name-one","name-two"]}]'
            '</small></span>'
            f'<textarea name="{name}" rows="8" spellcheck="false">{html.escape(value)}</textarea></label>'
        )

    value = html.escape(str(current), quote=True)
    if setting.kind == "select":
        options = "".join(
            f'<option value="{html.escape(choice, quote=True)}"'
            + (' selected' if choice == str(current) else '')
            + f'>{html.escape(choice.capitalize() if choice else "None")}</option>'
            for choice in setting.choices
        )
        return (
            '<label class="setting field-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<select name="{name}">{options}</select></label>'
        )
    attrs = ' type="text"'
    if setting.kind in {"number", "integer"}:
        minimum = setting.minimum if setting.minimum is not None else 0.1
        maximum = f' max="{setting.maximum}"' if setting.maximum is not None else ''
        step = '1' if setting.kind == "integer" else '0.1'
        attrs = f' type="number" min="{minimum}"{maximum} step="{step}" inputmode="decimal"'
    list_attr = ' list="ollama-models"' if setting.kind in {"model", "optional_model"} else ""
    if setting.kind == "color":
        required = ' placeholder="#43AF49"'
    elif setting.kind == "optional_text":
        required = ""
    elif setting.kind == "optional_model":
        required = ' placeholder="Choose a chat model"'
    else:
        required = " required"
    if setting.kind in {"model", "optional_model"}:
        return (
            '<div class="setting field-row model-row">'
            f'<span><label for="{name}"><strong>{label}</strong></label><small>{description}</small>'
            f'<small class="model-status" data-model="{name}" role="status"></small></span>'
            f'<input id="{name}"{attrs} name="{name}" value="{value}"{list_attr}{required}>'
            f'<button type="button" class="download-model" data-model="{name}">Download</button></div>'
        )
    return (
        '<label class="setting field-row">'
        f'<span><strong>{label}</strong><small>{description}</small></span>'
        f'<input{attrs} name="{name}" value="{value}"{list_attr}{required}></label>'
    )


def render_form(
    current: dict[str, object],
    models: list[str],
    ollama_status: str,
    token: str,
    action_label: str,
    error: str = "",
) -> str:
    sections = []
    for section in dict.fromkeys(setting.section for setting in SETTINGS):
        controls = "".join(
            _setting_control(setting, current.get(setting.name, ""))
            for setting in SETTINGS
            if setting.section == section
        )
        if section == "Branch names":
            controls = _pack_controls(current) + controls
        if section == "Codex":
            controls += (
                '<div class="setting textarea-row"><span><strong>Import ChatGPT personalization</strong>'
                '<small>Copy Custom Instructions from ChatGPT Personalization, then import them here. Saving mirrors '
                'the text into the global personalization used by the Codex VS Code extension.</small></span>'
                '<button type="button" id="sync-chatgpt-instructions">Import from ChatGPT</button></div>'
                '<label class="setting textarea-row"><span><strong>PGP secret key</strong>'
                '<small>Optional signing key for Codex and VS Code Git commits. Imported directly into GnuPG through stdin. '
                'The private key is never saved to Git config, rendered back into this page, or written to command output.</small></span>'
                '<textarea name="pgpSecretKey" rows="6" spellcheck="false" autocomplete="off" '
                'placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"></textarea></label>'
            )
        status = ""
        if section in {"Ollama", "Workspace Search"}:
            status = f'<p class="status">{html.escape(ollama_status)}</p>'
        sections.append(f'<section><h2>{html.escape(section)}</h2>{status}{controls}</section>')

    options = "".join(f'<option value="{html.escape(model, quote=True)}"></option>' for model in models)
    error_html = f'<div class="error" role="alert">{html.escape(error)}</div>' if error else ""
    action = "/save?token=" + urllib.parse.quote(token)
    models_json = json.dumps(models).replace("<", "\\u003c")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SCM Toolkit Setup</title><style>
:root{{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#f0f6fc;--muted:#8b949e;--accent:#2f81f7;--danger:#f85149}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{width:min(880px,calc(100% - 32px));margin:40px auto 96px}}header{{margin-bottom:24px}}h1{{margin:0 0 8px;font-size:30px}}header p,.status{{color:var(--muted)}}
section{{margin:16px 0;padding:8px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}}h2{{font-size:16px;margin:10px 0}}
.setting{{display:flex;align-items:center;gap:20px;min-height:62px;padding:10px 0;border-top:1px solid var(--line)}}.setting:first-of-type{{border-top:0}}.setting>span:first-child{{flex:1;min-width:0}}strong,small{{display:block}}small{{margin-top:2px;color:var(--muted)}}.model-row{{gap:12px}}.model-row input{{width:min(280px,38%)}}.model-row button{{flex:none}}button:disabled{{opacity:.6;cursor:default}}
.field-row input,.field-row select,.textarea-row textarea{{width:min(440px,52%);padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}}.textarea-row textarea{{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
.toggle-row input{{position:absolute;opacity:0;pointer-events:none}}.toggle{{position:relative;width:42px;height:24px;flex:none;border-radius:99px;background:#484f58;transition:.15s}}.toggle:after{{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:white;transition:.15s}}input:checked+.toggle{{background:var(--accent)}}input:checked+.toggle:after{{transform:translateX(18px)}}input:focus-visible+.toggle,.field-row input:focus,.field-row select:focus,.textarea-row textarea:focus{{outline:2px solid var(--accent);outline-offset:2px}}
.actions{{position:sticky;bottom:0;display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:24px;padding:16px;background:color-mix(in srgb,var(--bg) 92%,transparent);border:1px solid var(--line);border-radius:12px;backdrop-filter:blur(12px)}}.save-status{{margin-right:auto;color:var(--muted)}}.save-status.error-state{{color:#ffb3ad}}button{{padding:9px 15px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--text);font:inherit;cursor:pointer}}button.primary{{border-color:var(--accent);background:var(--accent);font-weight:600}}.error{{margin-bottom:16px;padding:12px;border:1px solid var(--danger);border-radius:8px;color:#ffb3ad}}
.pack-picker{{margin:12px 0;padding:14px;border:1px solid var(--line);border-radius:10px;min-width:0}}.pack-picker legend{{font-weight:600;padding:0 6px}}.pack-picker p{{margin:0 0 12px;color:var(--muted)}}.pack-toolbar{{display:flex;align-items:center;gap:12px;margin-bottom:12px}}.pack-toolbar input{{width:100%;min-width:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);font:inherit}}.pack-toolbar output{{white-space:nowrap;color:var(--muted);font-size:12px}}.pack-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;max-height:320px;overflow:auto;padding:3px}}.pack-card{{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:var(--bg);transition:border-color .15s,background .15s}}.pack-card:has(input:checked){{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,var(--bg))}}.pack-card:has(input:focus-visible){{outline:2px solid var(--accent);outline-offset:1px}}.pack-card input{{accent-color:var(--accent);width:16px;height:16px;flex:none}}.pack-card[hidden]{{display:none}}.pack-card strong{{font-size:13px}}.pack-card small{{font-size:12px}}
@media(max-width:620px){{main{{width:min(100% - 20px,880px);margin-top:20px}}.field-row,.textarea-row{{align-items:flex-start;flex-direction:column;gap:8px}}.field-row input,.field-row select,.textarea-row textarea{{width:100%}}}}
</style></head><body><main><header><h1>SCM Toolkit Setup</h1><p>Configure locally. Changes save automatically to global Git config. No data leaves this computer.</p></header>
{error_html}<form method="post" action="{action}">{''.join(sections)}<datalist id="ollama-models">{options}</datalist>
<div class="actions"><output id="save-status" class="save-status" role="status" aria-live="polite">Saved</output><button class="primary" type="submit" name="action" value="save">{html.escape(action_label)}</button></div></form>
<script>
const settingsForm = document.querySelector('form');
const saveStatus = document.getElementById('save-status');
let autosaveTimer = null;
let saveChain = Promise.resolve();

async function persistSettings() {{
  saveStatus.textContent = 'Saving…';
  saveStatus.classList.remove('error-state');
  const data = new FormData(settingsForm);
  data.delete('pgpSecretKey');
  data.delete('action');
  try {{
    const response = await fetch('/autosave' + location.search, {{
      method: 'POST',
      body: new URLSearchParams(data)
    }});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save settings.');
    saveStatus.textContent = 'Saved';
  }} catch (error) {{
    saveStatus.textContent = 'Not saved: ' + error.message;
    saveStatus.classList.add('error-state');
  }}
}}

function queueAutosave() {{
  saveChain = saveChain.then(persistSettings, persistSettings);
  return saveChain;
}}

function scheduleAutosave(event) {{
  const target = event.target;
  if (!target?.name || target.name === 'pgpSecretKey' || target.name === 'action') return;
  clearTimeout(autosaveTimer);
  saveStatus.textContent = 'Unsaved changes';
  saveStatus.classList.remove('error-state');
  autosaveTimer = setTimeout(() => {{
    autosaveTimer = null;
    void queueAutosave();
  }}, 500);
}}

if (settingsForm) {{
  settingsForm.addEventListener('input', scheduleAutosave);
  settingsForm.addEventListener('change', scheduleAutosave);
  settingsForm.addEventListener('submit', async event => {{
    event.preventDefault();
    if (autosaveTimer) {{
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      queueAutosave();
    }}
    await saveChain;
    HTMLFormElement.prototype.submit.call(settingsForm);
  }});
}}

const packSearch = document.getElementById('pack-search');
const packCards = [...document.querySelectorAll('.pack-card')];
function updatePacks() {{
  const query = packSearch.value.trim().toLocaleLowerCase();
  let visible = 0;
  let selected = 0;
  for (const card of packCards) {{
    card.hidden = !card.textContent.toLocaleLowerCase().includes(query);
    if (!card.hidden) visible++;
    if (card.querySelector('input').checked) selected++;
  }}
  document.getElementById('pack-count').textContent = `${{selected}} / ${{packCards.length}} selected`;
  document.getElementById('pack-empty').hidden = visible > 0;
}}
if (packSearch) {{
  packSearch.addEventListener('input', updatePacks);
  for (const card of packCards) card.addEventListener('change', updatePacks);
  updatePacks();
}}

let installedModels = {models_json};
const normalizeModel = name => name.split('/').pop().includes(':') ? name : name + ':latest';
function updateModelRows() {{
  for (const button of document.querySelectorAll('.download-model')) {{
    const input = document.getElementById(button.dataset.model);
    const status = document.querySelector('.model-status[data-model="' + button.dataset.model + '"]');
    if (button.dataset.busy) continue;
    const installed = installedModels.map(normalizeModel).includes(normalizeModel(input.value.trim()));
    status.textContent = !input.value.trim() ? 'Choose a model' : installed ? 'Installed locally' : 'Not installed — download to finish setup';
    button.disabled = installed || !input.value.trim();
    button.textContent = installed ? 'Installed' : 'Download';
  }}
}}
for (const button of document.querySelectorAll('.download-model')) {{
  document.getElementById(button.dataset.model).addEventListener('input', updateModelRows);
  button.addEventListener('click', async () => {{
    const input = document.getElementById(button.dataset.model);
    const status = document.querySelector('.model-status[data-model="' + button.dataset.model + '"]');
    button.dataset.busy = 'true'; button.disabled = true; input.disabled = true;
    const saveButton = document.querySelector('button[value="save"]');
    if (saveButton) saveButton.disabled = true;
    try {{
      status.textContent = 'Starting download…';
      const response = await fetch('/pull' + location.search, {{method: 'POST', body: new URLSearchParams({{model: input.value}})}});
      if (!response.ok) throw new Error((await response.json()).error);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let success = false;
      while (true) {{
        const {{value, done}} = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), {{stream: !done}});
        const lines = buffer.split('\\n'); buffer = lines.pop();
        for (const line of lines) {{
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.error) throw new Error(event.error);
          status.textContent = event.total ? 'Downloading ' + Math.round(100 * (event.completed || 0) / event.total) + '%' : event.status === 'success' ? 'Installed locally' : 'Preparing model…';
          success ||= event.status === 'success';
        }}
        if (done) break;
      }}
      if (!success) throw new Error('Download interrupted. Retry to resume.');
      const list = await fetch('/models' + location.search).then(r => r.json());
      installedModels = list.models;
      const choices = document.getElementById('ollama-models'); choices.replaceChildren();
      for (const name of installedModels) {{ const option = document.createElement('option'); option.value = name; choices.append(option); }}
      delete button.dataset.busy;
      updateModelRows();
    }} catch (error) {{ status.textContent = 'Could not download: ' + error.message; button.disabled = false; }}
    finally {{
      delete button.dataset.busy; input.disabled = false;
      if (saveButton) saveButton.disabled = !!document.querySelector('.download-model[data-busy]');
    }}
  }});
}}
updateModelRows();

const askOllamaToggle = document.querySelector('input[name="workspaceSearchAskOllama"]');
const askOllamaModel = document.querySelector('input[name="workspaceSearchChatModel"]');
function updateAskOllamaRequirement() {{
  if (!askOllamaToggle || !askOllamaModel) return;
  askOllamaModel.required = askOllamaToggle.checked;
}}
if (askOllamaToggle && askOllamaModel) {{
  askOllamaToggle.addEventListener('change', updateAskOllamaRequirement);
  updateAskOllamaRequirement();
}}
const syncButton = document.getElementById('sync-chatgpt-instructions');
if (syncButton) {{
  syncButton.addEventListener('click', async () => {{
    const target = document.querySelector('textarea[name="chatgptCustomInstructions"]');
    if (!target) return;
    try {{
      const value = await navigator.clipboard.readText();
      if (!value.trim()) throw new Error('Clipboard is empty.');
      target.value = value.trim();
      target.dispatchEvent(new Event('input', {{ bubbles: true }}));
      syncButton.textContent = 'Imported';
    }} catch (error) {{
      syncButton.textContent = 'Copy instructions, then retry';
      syncButton.title = String(error);
    }}
  }});
}}
</script>
</main></body></html>"""


def extension_settings_payload(settings: dict[str, bool | str]) -> dict[str, object]:
    payload = {
        group: {key: settings[name] for key, name in names.items()}
        for group, names in VSCODE_SETTINGS.items()
    }
    for key in ("resultLimit", "maxFiles"):
        payload["workspaceSearch"][key] = int(settings[VSCODE_SETTINGS["workspaceSearch"][key]])
    payload["workspaceSearch"]["maxFileSizeMB"] = float(settings["workspaceSearchMaxFileSizeMB"])
    return payload


def apply_vscode_settings(current, payload):
    for group, names in VSCODE_SETTINGS.items():
        for key, name in names.items():
            if key in payload.get(group, {}):
                current[name] = payload[group][key]


def _result_page(saved: bool) -> str:
    title = "Configuration saved" if saved else "Configuration cancelled"
    detail = "Return to the terminal to continue." if saved else "No settings were changed."
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>body{{margin:0;background:#0d1117;color:#f0f6fc;font:16px system-ui;display:grid;min-height:100vh;place-items:center}}main{{text-align:center;padding:32px}}p{{color:#8b949e}}</style></head><body><main><h1>{title}</h1><p>{detail} You may close this tab.</p></main></body></html>"""


def run_configurator(
    current: dict[str, object], action_label: str = "Done", *, open_browser: bool = True
) -> bool:
    token = secrets.token_urlsafe(24)
    outcome: dict[str, bool | None] = {"saved": None}
    session_settings = dict(current)

    class Handler(BaseHTTPRequestHandler):
        def _send(self, content: str, status: int = 200) -> None:
            body = content.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, payload: dict, status: int = 200) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            return secrets.compare_digest(query.get("token", [""])[0], token)

        def do_GET(self) -> None:
            if not self._authorized():
                self._send("<h1>Not found</h1>", 404)
                return
            if urllib.parse.urlsplit(self.path).path == "/models":
                names, status = fetch_ollama_models()
                self._send_json({"models": names, "status": status})
                return
            names, status = fetch_ollama_models()
            self._send(render_form(session_settings, names, status, token, action_label))

        def do_POST(self) -> None:
            if not self._authorized():
                self._send("<h1>Not found</h1>", 404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send("<h1>Invalid request</h1>", 400)
                return
            if length < 0 or length > MAX_FORM_BYTES:
                self._send("<h1>Request too large</h1>", 413)
                return
            values = urllib.parse.parse_qs(
                self.rfile.read(length).decode("utf-8"), keep_blank_values=True
            )
            if urllib.parse.urlsplit(self.path).path == "/pull":
                try:
                    name = model_tag(values.get("model", [""])[0])
                    response = ollama_request("/api/pull", {"model": name, "stream": True}, timeout=3600)
                except Exception as error:
                    self._send_json({"error": str(error)}, 400)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    with response:
                        for line in response:
                            self.wfile.write(line)
                            self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception:
                    self.wfile.write(b'{"error":"Download interrupted. Retry the download."}\n')
                return
            if urllib.parse.urlsplit(self.path).path == "/autosave":
                parsed = {}
                try:
                    parsed = parse_submission(values)
                    validate_models(parsed)
                    save_settings(parsed)
                    sync_codex_instructions(
                        str(parsed["chatgptCustomInstructions"]),
                        bool(parsed["chatgptWebCodexCoauthor"]),
                    )
                except (RuntimeError, ValueError) as error:
                    self._send_json({"saved": False, "error": str(error)}, 400)
                    return
                session_settings.update(parsed)
                if not open_browser:
                    print(json.dumps(extension_settings_payload(parsed)), flush=True)
                self._send_json({"saved": True})
                return
            if values.get("action", [""])[0] == "cancel":
                outcome["saved"] = False
                self._send(_result_page(False))
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            parsed = {}
            try:
                parsed = parse_submission(values)
                validate_models(parsed)
                save_settings(parsed)
                sync_codex_instructions(
                    str(parsed["chatgptCustomInstructions"]),
                    bool(parsed["chatgptWebCodexCoauthor"]),
                )
                import_pgp_secret_key(values.get("pgpSecretKey", [""])[0])
            except (RuntimeError, ValueError) as error:
                names, status = fetch_ollama_models()
                submitted = dict(session_settings)
                submitted.update(parsed)
                self._send(render_form(submitted, names, status, token, action_label, str(error)), 400)
                return
            session_settings.update(parsed)
            outcome["saved"] = True
            if not open_browser:
                print(json.dumps(extension_settings_payload(parsed)), flush=True)
            self._send(_result_page(True))
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    url = f"http://127.0.0.1:{server.server_port}/?token={urllib.parse.quote(token)}"
    if open_browser:
        print(f"SCM Toolkit configurator: {url}")
        if not webbrowser.open(url):
            print("Open the URL above in a browser.")
    else:
        print(json.dumps({"url": url}), flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        print("\nConfiguration cancelled.")
    finally:
        server.server_close()
    return outcome["saved"] is True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true", help="Send the URL to the calling extension.")
    parser.add_argument("--vscode-settings", help="Current feature preferences supplied by the companion extension.")
    parser.add_argument(
        "--open-panel-on-startup",
        choices=("true", "false"),
        help="Current VS Code user setting supplied by the companion extension.",
    )
    args = parser.parse_args()
    current = load_settings()
    if args.vscode_settings is not None:
        apply_vscode_settings(current, json.loads(args.vscode_settings))
    if args.open_panel_on_startup is not None:
        current["openPanelOnStartup"] = args.open_panel_on_startup == "true"
    run_configurator(current, open_browser=not args.no_browser)
