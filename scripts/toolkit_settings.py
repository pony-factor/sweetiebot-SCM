"""Global Git-backed settings shared by the Sweetiebot SCM installers and UI."""

from __future__ import annotations

import subprocess
from pathlib import Path

from message_bar import DEFAULT_MESSAGE_BAR_LAYOUT_JSON, MESSAGE_BAR_VISIBILITY_SETTINGS, parse_message_bar_layout


DEFAULT_SETTINGS = {
    "branchPicker": True,
    "horizontalBranchSelector": True,
    "messageBarLayout": DEFAULT_MESSAGE_BAR_LAYOUT_JSON,
    "ponyBranch": True,
    "branchNameDisabledPacks": "pony-life,idw-comics,g5-remaining,g4-pets",
    "branchCustomNames": "",
    "branchNameImports": "[]",
    "messagePlaceholder": "Message",
    "commitButtonLabel": "Send",
    "commitAndSendButtonLabel": "Send",
    "sourceControlLabel": "Sweetiebot",
    "nativeAppUpdateMode": "default",
    "nativeExtensionAutoCheckUpdates": True,
    "nativeExtensionAutoUpdate": True,
    "automaticAppRepair": True,
    "openPanelOnStartup": True,
    "notificationPosition": "bottom-left",
    "workspaceSearchActivityBar": False,
    "workspaceSearchLabel": "EFS",
    "workspaceSearchPlaceholder": "Search your workspace…",
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
    "automaticWorkspaceCleanup": True,
    "pullRequestAutoRefresh": True,
    "pullRequestRefreshIntervalSeconds": "120",
    "pullRequestQuickMerge": True,
    "autoPublishPullRequests": True,
    "mergeTimelineTimestampMode": "hidden",
    "mergeSidebarWidthPercent": "37",
    "mergeTimelineHeightPercent": "34",
    "kefaniaUseThemeColors": True,
    "kefaniaShowCloseButton": True,
    "kefaniaCloseAfterMerge": False,
    "kefaniaCloseButtonPosition": "left",
    "ludicrousMode": False,
    "chatgptProjectUrl": "",
    "workspaceSearchAutoReindex": True,
    "hideSCMProgress": True,
    "inlineSuggestions": True,
    "postCommitAction": "none",
    "workspaceSearchOllamaUrl": "http://127.0.0.1:11434",
    "workspaceSearchMode": "hybrid",
    "workspaceSearchResultLimit": "100",
    "workspaceSearchMaxFiles": "5000",
    "workspaceSearchMaxFileSizeMB": "10",
    "workspaceSearchExclude": "**/{.git,node_modules,dist,build,out,target,.venv,venv,__pycache__,coverage}/**",
    "codexCoauthor": True,
    "codexCoauthorName": "Codex",
    "codexCoauthorEmail": "noreply@openai.com",
    "codexCommitContext": False,
    "codexKeepAwake": True,
    "codexWindowLabel": "Codex",
    "hideIncomingSyncCount": False,
    "hideOutgoingSyncCount": True,
    "hideIncomingSyncArrow": False,
    "hideOutgoingSyncArrow": False,
    "incomingSyncLabel": "",
    "outgoingSyncLabel": "",
    "blankStateRefresh": True,
    "autoPullClean": True,
    "cloudRepositorySync": False,
    "cmdClickCloseOthers": False,
    "compactWindowButton": True,
    "newWorkspaceWindowButton": True,
    "browserGlobeNewTab": False,
    "browserChatgptHome": False,
    "browserHomeUrl": "https://chatgpt.com/",
    "graphOpenWorkingFile": True,
    "aiCommit": True,
    "aiCommitAsync": False,
    "durableBackgroundCommits": False,
    "aiDetailedCommitStyle": False,
    "aiTitleExplanations": False,
    "aiCommitFallback": True,
    "aiCommitRequestTimeoutSeconds": "45",
    "aiCommitAttempts": "3",
    "normalizeStagedWhitespace": True,
    "spellcheckManualCommit": False,
    "draftSpellcheckAction": "automatic",
    "draftSpellcheckDelaySeconds": "1.5",
    "draftSpellcheckStyle": "spelling",
    "draftSpellcheckVocabulary": "",
    "draftSpellcheckGuidance": "",
    "draftCommitEmoji": False,
    "postCommitSpellcheck": False,
    "spellcheckPreserveLineBreaks": False,
    "aiDefaultBranchDescription": True,
    "aiEmojiPriorityRules": True,
    "aiCommitModel": "qwen2.5-coder:7b",
    "spellcheckModel": "qwen2.5:3b",
    "spellcheckInstructions": "Recognize financial market terminology and proper names, including Instinet. Correct an obvious misspelling only when context identifies the term; do not substitute a different entity.",
    "aiCommitLowMemoryModel": "qwen2.5-coder:3b",
    "aiLowMemoryGiB": "4",
    "aiModelPicker": True,
    "mcpPullRequest": True,
    "mcpPrServer": "codex-drafter",
    "mcpPrTool": "github_create_pull_request",
    "codexUsageResetCountdown": False,
    "codexHideUsageResetTimes": False,
    "codexUsagePieIndicator": False,
    "codexHidePromotions": False,
    "codexHideDictation": False,
    "codexShortModelLabels": False,
    "codexHideChatTimestamps": False,
    "codexHideAccessLabel": False,
    "codexInlineLocation": True,
    "codexClipboardSubmit": True,
    "codexSendBackground": "",
    "codexNewChatDotColor": "",
    "codexSendForeground": "",
    "codexComposerLabelColor": "",
    "codexDropAccent": "",
    "codexNewChatPlaceholder": "",
    "codexFollowUpPlaceholder": "",
    "defaultBranch": "main",
    "remote": "origin",
}


def read_git_bool(key, default):
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--type=bool", "--get", key],
            capture_output=True,
            text=True,
            cwd=Path.home(),
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
            cwd=Path.home(),
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
    # Honor an existing right-hand preference until the user saves a dropdown choice.
    new_position = read_git_string(SETTING_KEYS["kefaniaCloseButtonPosition"], None)
    if new_position is None:
        settings["kefaniaCloseButtonPosition"] = (
            "left" if read_git_bool("scm-toolkit.kefania-close-button-left", True) else "right"
        )
    elif new_position not in {"left", "middle", "right"}:
        settings["kefaniaCloseButtonPosition"] = "left"
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
        capture_output=True, text=True, cwd=Path.home(),
    )
    if result.returncode != 0:
        raise RuntimeError("Unable to save the message bar layout: " + result.stderr.strip())


SETTING_KEYS = {
    "branchPicker": "scm-toolkit.branch-picker",
    "horizontalBranchSelector": "scm-toolkit.horizontal-branch-selector",
    "messageBarLayout": "scm-toolkit.message-bar-layout",
    "ponyBranch": "scm-toolkit.pony-branch",
    "branchNameDisabledPacks": "scm-toolkit.branch-name-disabled-packs",
    "branchCustomNames": "scm-toolkit.branch-custom-names",
    "branchNameImports": "scm-toolkit.branch-name-imports",
    "messagePlaceholder": "scm-toolkit.message-placeholder",
    "commitButtonLabel": "scm-toolkit.commit-button-label",
    "commitAndSendButtonLabel": "scm-toolkit.commit-and-send-button-label",
    "sourceControlLabel": "scm-toolkit.source-control-label",
    "nativeAppUpdateMode": "scm-toolkit.native-app-update-mode",
    "nativeExtensionAutoCheckUpdates": "scm-toolkit.native-extension-auto-check-updates",
    "nativeExtensionAutoUpdate": "scm-toolkit.native-extension-auto-update",
    "automaticAppRepair": "scm-toolkit.automatic-app-repair",
    "openPanelOnStartup": "scm-toolkit.open-panel-on-startup",
    "notificationPosition": "scm-toolkit.notification-position",
    "workspaceSearchActivityBar": "scm-toolkit.workspace-search-activity-bar",
    "workspaceSearchLabel": "scm-toolkit.workspace-search-label",
    "workspaceSearchPlaceholder": "scm-toolkit.workspace-search-placeholder",
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
    "automaticWorkspaceCleanup": "scm-toolkit.automatic-workspace-cleanup",
    "pullRequestAutoRefresh": "scm-toolkit.pull-request-auto-refresh",
    "pullRequestRefreshIntervalSeconds": "scm-toolkit.pull-request-refresh-interval-seconds",
    "pullRequestQuickMerge": "scm-toolkit.pull-request-quick-merge",
    "autoPublishPullRequests": "scm-toolkit.auto-publish-pull-requests",
    "mergeTimelineTimestampMode": "scm-toolkit.merge-timeline-timestamp-mode",
    "mergeSidebarWidthPercent": "scm-toolkit.merge-sidebar-width-percent",
    "mergeTimelineHeightPercent": "scm-toolkit.merge-timeline-height-percent",
    "kefaniaUseThemeColors": "scm-toolkit.kefania-use-theme-colors",
    "kefaniaShowCloseButton": "scm-toolkit.kefania-show-close-button",
    "kefaniaCloseAfterMerge": "scm-toolkit.kefania-close-after-merge",
    "kefaniaCloseButtonPosition": "scm-toolkit.kefania-close-button-position",
    "ludicrousMode": "scm-toolkit.ludicrous-mode",
    "chatgptProjectUrl": "scm-toolkit.chatgpt-project-url",
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
    "codexCoauthorName": "scm-toolkit.codex-coauthor-name",
    "codexCoauthorEmail": "scm-toolkit.codex-coauthor-email",
    "codexCommitContext": "scm-toolkit.codex-commit-context",
    "codexKeepAwake": "scm-toolkit.codex-keep-awake",
    "codexWindowLabel": "scm-toolkit.codex-window-label",
    "hideIncomingSyncCount": "scm-toolkit.hide-incoming-sync-count",
    "hideOutgoingSyncCount": "scm-toolkit.hide-outgoing-sync-count",
    "hideIncomingSyncArrow": "scm-toolkit.hide-incoming-sync-arrow",
    "hideOutgoingSyncArrow": "scm-toolkit.hide-outgoing-sync-arrow",
    "incomingSyncLabel": "scm-toolkit.incoming-sync-label",
    "outgoingSyncLabel": "scm-toolkit.outgoing-sync-label",
    "blankStateRefresh": "scm-toolkit.blank-state-refresh",
    "autoPullClean": "scm-toolkit.auto-pull-clean",
    "cloudRepositorySync": "scm-toolkit.cloud-repository-sync",
    "cmdClickCloseOthers": "scm-toolkit.cmd-click-close-others",
    "compactWindowButton": "scm-toolkit.compact-window-button",
    "newWorkspaceWindowButton": "scm-toolkit.new-workspace-window-button",
    "browserGlobeNewTab": "scm-toolkit.browser-globe-new-tab",
    "browserChatgptHome": "scm-toolkit.browser-chatgpt-home",
    "browserHomeUrl": "scm-toolkit.browser-home-url",
    "graphOpenWorkingFile": "scm-toolkit.graph-open-working-file",
    "aiCommit": "scm-toolkit.ai-commit",
    "aiCommitAsync": "scm-toolkit.ai-commit-async",
    "durableBackgroundCommits": "scm-toolkit.durable-background-commits",
    "aiDetailedCommitStyle": "scm-toolkit.ai-detailed-commit-style",
    "aiTitleExplanations": "scm-toolkit.ai-title-explanations",
    "aiCommitFallback": "scm-toolkit.ai-commit-fallback",
    "aiCommitRequestTimeoutSeconds": "scm-toolkit.ai-commit-request-timeout-seconds",
    "aiCommitAttempts": "scm-toolkit.ai-commit-attempts",
    "normalizeStagedWhitespace": "scm-toolkit.normalize-staged-whitespace",
    "spellcheckManualCommit": "scm-toolkit.spellcheck-preview",
    "draftSpellcheckAction": "scm-toolkit.draft-spellcheck-action",
    "draftSpellcheckDelaySeconds": "scm-toolkit.draft-spellcheck-delay-seconds",
    "draftSpellcheckStyle": "scm-toolkit.draft-spellcheck-style",
    "draftSpellcheckVocabulary": "scm-toolkit.draft-spellcheck-vocabulary",
    "draftSpellcheckGuidance": "scm-toolkit.draft-spellcheck-guidance",
    "draftCommitEmoji": "scm-toolkit.draft-commit-emoji",
    "postCommitSpellcheck": "scm-toolkit.post-commit-spellcheck",
    "spellcheckPreserveLineBreaks": "scm-toolkit.spellcheck-preserve-line-breaks",
    "aiDefaultBranchDescription": "scm-toolkit.ai-default-branch-description",
    "aiEmojiPriorityRules": "scm-toolkit.ai-emoji-priority-rules",
    "aiCommitModel": "scm-toolkit.ai-commit-model",
    "spellcheckModel": "scm-toolkit.spellcheck-model",
    "spellcheckInstructions": "scm-toolkit.spellcheck-instructions",
    "aiCommitLowMemoryModel": "scm-toolkit.ai-commit-low-memory-model",
    "aiLowMemoryGiB": "scm-toolkit.ai-low-memory-gib",
    "aiModelPicker": "scm-toolkit.ai-model-picker",
    "mcpPullRequest": "scm-toolkit.mcp-pull-request",
    "mcpPrServer": "scm-toolkit.mcp-pr-server",
    "mcpPrTool": "scm-toolkit.mcp-pr-tool",
    "codexUsageResetCountdown": "scm-toolkit.codex-usage-reset-countdown",
    "codexHideUsageResetTimes": "scm-toolkit.codex-hide-usage-reset-times",
    "codexUsagePieIndicator": "scm-toolkit.codex-usage-pie-indicator",
    "codexHidePromotions": "scm-toolkit.codex-hide-promotions",
    "codexHideDictation": "scm-toolkit.codex-hide-dictation",
    "codexShortModelLabels": "scm-toolkit.codex-short-model-labels",
    "codexHideChatTimestamps": "scm-toolkit.codex-hide-chat-timestamps",
    "codexHideAccessLabel": "scm-toolkit.codex-hide-access-label",
    "codexInlineLocation": "scm-toolkit.codex-inline-location",
    "codexClipboardSubmit": "scm-toolkit.codex-clipboard-submit",
    "codexSendBackground": "scm-toolkit.codex-send-background",
    "codexNewChatDotColor": "scm-toolkit.codex-new-chat-dot-color",
    "codexSendForeground": "scm-toolkit.codex-send-foreground",
    "codexComposerLabelColor": "scm-toolkit.codex-composer-label-color",
    "codexDropAccent": "scm-toolkit.codex-drop-accent",
    "codexNewChatPlaceholder": "scm-toolkit.codex-new-chat-placeholder",
    "codexFollowUpPlaceholder": "scm-toolkit.codex-follow-up-placeholder",
    "defaultBranch": "scm-toolkit.default-branch",
    "remote": "scm-toolkit.remote",
}


# Gear-page names mapped to the settings consumed by VS Code at runtime.
VSCODE_SETTINGS = {
    "workspaceSearch": {
        "embeddingModel": "workspaceSearchEmbeddingModel",
        "chatModel": "workspaceSearchChatModel",
        "placeholder": "workspaceSearchPlaceholder",
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
        "compactWindowButton": "compactWindowButton",
        "newWorkspaceWindowButton": "newWorkspaceWindowButton",
        "automaticAppRepair": "automaticAppRepair",
        "openPanelOnStartup": "openPanelOnStartup",
        "sourceControlLabel": "sourceControlLabel",
        "messageBarLayout": "messageBarLayout",
        "messagePlaceholder": "messagePlaceholder",
        "commitButtonLabel": "commitButtonLabel",
        "commitAndSendButtonLabel": "commitAndSendButtonLabel",
        "hideIncomingSyncCount": "hideIncomingSyncCount",
        "hideOutgoingSyncCount": "hideOutgoingSyncCount",
        "hideIncomingSyncArrow": "hideIncomingSyncArrow",
        "hideOutgoingSyncArrow": "hideOutgoingSyncArrow",
        "incomingSyncLabel": "incomingSyncLabel",
        "outgoingSyncLabel": "outgoingSyncLabel",
        "autoPublishNewBranches": "autoPublishNewBranches",
        "automaticBranchCleanup": "automaticBranchCleanup",
        "automaticWorkspaceCleanup": "automaticWorkspaceCleanup",
        "cloudRepositorySync": "cloudRepositorySync",
        "pullRequestAutoRefresh": "pullRequestAutoRefresh",
        "pullRequestRefreshIntervalSeconds": "pullRequestRefreshIntervalSeconds",
        "pullRequestQuickMerge": "pullRequestQuickMerge",
        "autoPublishPullRequests": "autoPublishPullRequests",
        "mergeTimelineTimestampMode": "mergeTimelineTimestampMode",
        "mergeSidebarWidthPercent": "mergeSidebarWidthPercent",
        "mergeTimelineHeightPercent": "mergeTimelineHeightPercent",
        "kefaniaUseThemeColors": "kefaniaUseThemeColors",
        "kefaniaShowCloseButton": "kefaniaShowCloseButton",
        "kefaniaCloseAfterMerge": "kefaniaCloseAfterMerge",
        "kefaniaCloseButtonPosition": "kefaniaCloseButtonPosition",
        "chatgptProjectUrl": "chatgptProjectUrl",
        "codexKeepAwake": "codexKeepAwake",
        "durableBackgroundCommits": "durableBackgroundCommits",
    },
    "appUpdateSettings": {"mode": "nativeAppUpdateMode"},
    "extensionUpdateSettings": {"autoCheckUpdates": "nativeExtensionAutoCheckUpdates", "autoUpdate": "nativeExtensionAutoUpdate"},
    "workbenchNotificationSettings": {"position": "notificationPosition"},
    "editorSettings": {"inlineSuggest.enabled": "inlineSuggestions"},
    "gitSettings": {"postCommitCommand": "postCommitAction"},
}
