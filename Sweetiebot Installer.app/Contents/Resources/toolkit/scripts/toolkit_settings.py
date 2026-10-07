"""Global Git-backed settings shared by the Sweetiebot SCM installers and UI."""

from __future__ import annotations

import subprocess

from message_bar import DEFAULT_MESSAGE_BAR_LAYOUT_JSON, MESSAGE_BAR_VISIBILITY_SETTINGS, parse_message_bar_layout


DEFAULT_SETTINGS = {
    "branchPicker": True,
    "messageBarLayout": DEFAULT_MESSAGE_BAR_LAYOUT_JSON,
    "ponyBranch": True,
    "branchNameDisabledPacks": "pony-life,idw-comics,g5-remaining",
    "branchCustomNames": "",
    "branchNameImports": "[]",
    "messagePlaceholder": "Message",
    "commitButtonLabel": "Send",
    "commitAndSendButtonLabel": "Send",
    "sourceControlLabel": "Sweetie Bot",
    "automaticAppRepair": True,
    "openPanelOnStartup": True,
    "notificationPosition": "bottom-left",
    "workspaceSearchActivityBar": False,
    "workspaceSearchLabel": "EFS",
    "workspaceSearchAskOllama": False,
    "workspaceSearchChatModel": "",
    "workspaceSearchEmbeddingModel": "qwen3-embedding:0.6b",
    "filledButtons": False,
    "commitAndPush": True,
    "branchCleanup": True,
    "autocompleteToggle": True,
    "autoPublishToggle": True,
    "autoPublishNewBranches": False,
    "automaticBranchCleanup": True,
    "pullRequestAutoRefresh": True,
    "pullRequestQuickMerge": True,
    "workspaceSearchAutoReindex": True,
    "hideSCMProgress": True,
    "inlineSuggestions": True,
    "postCommitAction": "none",
    "workspaceSearchOllamaUrl": "http://127.0.0.1:11434",
    "workspaceSearchMode": "hybrid",
    "workspaceSearchResultLimit": "20",
    "workspaceSearchMaxFiles": "5000",
    "workspaceSearchMaxFileSizeMB": "10",
    "workspaceSearchExclude": "**/{.git,node_modules,dist,build,out,target,.venv,venv,__pycache__,coverage}/**",
    "codexCoauthor": True,
    "codexCommitContext": False,
    "codexKeepAwake": True,
    "hideOutgoingSyncCount": True,
    "blankStateRefresh": True,
    "autoPullClean": True,
    "cmdClickCloseOthers": False,
    "browserGlobeNewTab": False,
    "browserChatgptHome": False,
    "browserHomeUrl": "https://chatgpt.com/",
    "graphOpenWorkingFile": True,
    "aiCommit": True,
    "postCommitSpellcheck": False,
    "aiDefaultBranchDescription": True,
    "aiCommitModel": "qwen2.5-coder:7b",
    "aiCommitLowMemoryModel": "qwen2.5-coder:3b",
    "aiLowMemoryGiB": "4",
    "aiModelPicker": True,
    "mcpPullRequest": True,
    "mcpPrServer": "codex-drafter",
    "mcpPrTool": "github_create_pull_request",
    "codexUsageResetCountdown": False,
    "codexUsagePieIndicator": False,
    "codexHidePromotions": False,
    "codexHideDictation": False,
    "codexShortModelLabels": False,
    "codexHideChatTimestamps": False,
    "codexHideAccessLabel": False,
    "codexInlineLocation": True,
    "codexSendBackground": "",
    "codexSendForeground": "",
    "codexComposerLabelColor": "",
    "codexDropAccent": "",
    "defaultBranch": "main",
    "remote": "origin",
}


def read_git_bool(key, default):
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--type=bool", "--get", key],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return default

    if result.returncode == 1:
        return default
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read global Git config key {key}: {result.stderr.strip()}")
    return result.stdout.strip() == "true"


def read_git_string(key, default, preserve_empty=False):
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--get", key],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return default

    if result.returncode == 1:
        return default
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read global Git config key {key}: {result.stderr.strip()}")
    value = result.stdout.strip()
    return value if value or preserve_empty else default


def load_settings():
    settings = {}
    for name, default in DEFAULT_SETTINGS.items():
        git_key = SETTING_KEYS[name]
        if name == "messagePlaceholder":
            value = read_git_string(git_key, None, preserve_empty=True)
            if value is None:
                value = "Message" if read_git_bool("scm-toolkit.short-placeholder", True) else ""
            settings[name] = value
        elif isinstance(default, bool):
            settings[name] = read_git_bool(git_key, default)
        else:
            settings[name] = read_git_string(
                git_key,
                default,
                preserve_empty=name == "branchNameDisabledPacks",
            )
    if settings["postCommitAction"] not in {"none", "push"}:
        settings["postCommitAction"] = "none"
    # Represent legacy disabled buttons in the layout so the editor reflects
    # existing preferences before its first save.
    try:
        layout = parse_message_bar_layout(settings["messageBarLayout"])
    except ValueError:
        return settings
    changed = False
    if settings["commitAndPush"] and not any("push" in items for items in layout.values()):
        layout["after"].insert(0, "push")
        changed = True
    disabled = {item for name, item in MESSAGE_BAR_VISIBILITY_SETTINGS.items() if not settings[name]}
    if not settings["branchPicker"]:
        disabled.update(("sync", "home"))
    if changed or any(item in disabled for items in layout.values() for item in items):
        import json
        settings["messageBarLayout"] = json.dumps({
            zone: [item for item in items if item not in disabled]
            for zone, items in layout.items()
        }, separators=(",", ":"))
    return settings


def persist_message_bar_layout(settings):
    """Pin the initial layout so future default changes do not reorder it."""
    key = SETTING_KEYS["messageBarLayout"]
    if read_git_string(key, None, preserve_empty=True) is not None:
        return
    result = subprocess.run(
        ["git", "config", "--global", key, str(settings["messageBarLayout"])],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("Unable to save the message bar layout: " + result.stderr.strip())


SETTING_KEYS = {
    "branchPicker": "scm-toolkit.branch-picker",
    "messageBarLayout": "scm-toolkit.message-bar-layout",
    "ponyBranch": "scm-toolkit.pony-branch",
    "branchNameDisabledPacks": "scm-toolkit.branch-name-disabled-packs",
    "branchCustomNames": "scm-toolkit.branch-custom-names",
    "branchNameImports": "scm-toolkit.branch-name-imports",
    "messagePlaceholder": "scm-toolkit.message-placeholder",
    "commitButtonLabel": "scm-toolkit.commit-button-label",
    "commitAndSendButtonLabel": "scm-toolkit.commit-and-send-button-label",
    "sourceControlLabel": "scm-toolkit.source-control-label",
    "automaticAppRepair": "scm-toolkit.automatic-app-repair",
    "openPanelOnStartup": "scm-toolkit.open-panel-on-startup",
    "notificationPosition": "scm-toolkit.notification-position",
    "workspaceSearchActivityBar": "scm-toolkit.workspace-search-activity-bar",
    "workspaceSearchLabel": "scm-toolkit.workspace-search-label",
    "workspaceSearchAskOllama": "scm-toolkit.workspace-search-ask-ollama",
    "workspaceSearchChatModel": "scm-toolkit.workspace-search-chat-model",
    "workspaceSearchEmbeddingModel": "scm-toolkit.workspace-search-embedding-model",
    "filledButtons": "scm-toolkit.filled-buttons",
    "commitAndPush": "scm-toolkit.commit-and-push",
    "branchCleanup": "scm-toolkit.branch-cleanup",
    "autocompleteToggle": "scm-toolkit.autocomplete-toggle",
    "autoPublishToggle": "scm-toolkit.auto-publish-toggle",
    "autoPublishNewBranches": "scm-toolkit.auto-publish-new-branches",
    "automaticBranchCleanup": "scm-toolkit.automatic-branch-cleanup",
    "pullRequestAutoRefresh": "scm-toolkit.pull-request-auto-refresh",
    "pullRequestQuickMerge": "scm-toolkit.pull-request-quick-merge",
    "workspaceSearchAutoReindex": "scm-toolkit.workspace-search-auto-reindex",
    "hideSCMProgress": "scm-toolkit.hide-scm-progress",
    "inlineSuggestions": "scm-toolkit.inline-suggestions",
    "postCommitAction": "scm-toolkit.post-commit-action",
    "workspaceSearchOllamaUrl": "scm-toolkit.workspace-search-ollama-url",
    "workspaceSearchMode": "scm-toolkit.workspace-search-mode",
    "workspaceSearchResultLimit": "scm-toolkit.workspace-search-result-limit",
    "workspaceSearchMaxFiles": "scm-toolkit.workspace-search-max-files",
    "workspaceSearchMaxFileSizeMB": "scm-toolkit.workspace-search-max-file-size-mb",
    "workspaceSearchExclude": "scm-toolkit.workspace-search-exclude",
    "codexCoauthor": "scm-toolkit.codex-coauthor",
    "codexCommitContext": "scm-toolkit.codex-commit-context",
    "codexKeepAwake": "scm-toolkit.codex-keep-awake",
    "hideOutgoingSyncCount": "scm-toolkit.hide-outgoing-sync-count",
    "blankStateRefresh": "scm-toolkit.blank-state-refresh",
    "autoPullClean": "scm-toolkit.auto-pull-clean",
    "cmdClickCloseOthers": "scm-toolkit.cmd-click-close-others",
    "browserGlobeNewTab": "scm-toolkit.browser-globe-new-tab",
    "browserChatgptHome": "scm-toolkit.browser-chatgpt-home",
    "browserHomeUrl": "scm-toolkit.browser-home-url",
    "graphOpenWorkingFile": "scm-toolkit.graph-open-working-file",
    "aiCommit": "scm-toolkit.ai-commit",
    "postCommitSpellcheck": "scm-toolkit.post-commit-spellcheck",
    "aiDefaultBranchDescription": "scm-toolkit.ai-default-branch-description",
    "aiCommitModel": "scm-toolkit.ai-commit-model",
    "aiCommitLowMemoryModel": "scm-toolkit.ai-commit-low-memory-model",
    "aiLowMemoryGiB": "scm-toolkit.ai-low-memory-gib",
    "aiModelPicker": "scm-toolkit.ai-model-picker",
    "mcpPullRequest": "scm-toolkit.mcp-pull-request",
    "mcpPrServer": "scm-toolkit.mcp-pr-server",
    "mcpPrTool": "scm-toolkit.mcp-pr-tool",
    "codexUsageResetCountdown": "scm-toolkit.codex-usage-reset-countdown",
    "codexUsagePieIndicator": "scm-toolkit.codex-usage-pie-indicator",
    "codexHidePromotions": "scm-toolkit.codex-hide-promotions",
    "codexHideDictation": "scm-toolkit.codex-hide-dictation",
    "codexShortModelLabels": "scm-toolkit.codex-short-model-labels",
    "codexHideChatTimestamps": "scm-toolkit.codex-hide-chat-timestamps",
    "codexHideAccessLabel": "scm-toolkit.codex-hide-access-label",
    "codexInlineLocation": "scm-toolkit.codex-inline-location",
    "codexSendBackground": "scm-toolkit.codex-send-background",
    "codexSendForeground": "scm-toolkit.codex-send-foreground",
    "codexComposerLabelColor": "scm-toolkit.codex-composer-label-color",
    "codexDropAccent": "scm-toolkit.codex-drop-accent",
    "defaultBranch": "scm-toolkit.default-branch",
    "remote": "scm-toolkit.remote",
}


# Gear-page names mapped to the settings consumed by VS Code at runtime.
VSCODE_SETTINGS = {
    "workspaceSearch": {
        "embeddingModel": "workspaceSearchEmbeddingModel",
        "chatModel": "workspaceSearchChatModel",
        "askOllama": "workspaceSearchAskOllama",
        "ollamaUrl": "workspaceSearchOllamaUrl",
        "mode": "workspaceSearchMode",
        "resultLimit": "workspaceSearchResultLimit",
        "maxFiles": "workspaceSearchMaxFiles",
        "maxFileSizeMB": "workspaceSearchMaxFileSizeMB",
        "exclude": "workspaceSearchExclude",
        "autoReindex": "workspaceSearchAutoReindex",
    },
    "vscodeSettings": {
        "automaticAppRepair": "automaticAppRepair",
        "openPanelOnStartup": "openPanelOnStartup",
        "messagePlaceholder": "messagePlaceholder",
        "commitButtonLabel": "commitButtonLabel",
        "commitAndSendButtonLabel": "commitAndSendButtonLabel",
        "autoPublishNewBranches": "autoPublishNewBranches",
        "automaticBranchCleanup": "automaticBranchCleanup",
        "pullRequestAutoRefresh": "pullRequestAutoRefresh",
        "pullRequestQuickMerge": "pullRequestQuickMerge",
        "codexKeepAwake": "codexKeepAwake",
    },
    "workbenchNotificationSettings": {"position": "notificationPosition"},
    "editorSettings": {"inlineSuggest.enabled": "inlineSuggestions"},
    "gitSettings": {"postCommitCommand": "postCommitAction"},
}
