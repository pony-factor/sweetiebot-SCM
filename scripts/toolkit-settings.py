"""Global Git-backed settings shared by the Sweetiebot SCM installers and UI."""

from __future__ import annotations

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


import subprocess
from pathlib import Path

from codex_composer_layout import DEFAULT_LAYOUT_JSON as CODEX_LAYOUT_DEFAULT_JSON
from message_bar import DEFAULT_MESSAGE_BAR_LAYOUT_JSON, MESSAGE_BAR_VISIBILITY_SETTINGS, parse_message_bar_layout


DEFAULT_PLACEHOLDER_PREFIX = "hoof_"
PLACEHOLDER_PREFIX_PATTERN = r"[A-Za-z][A-Za-z0-9_-]{0,14}_"


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
    "filterSyncCommitSummaries": True,
    "squashOmitBulletsForEmojiTitles": False,
    "squashTrailerSeparatorStyle": "underscores",
    "mergeAutoRefresh": True,
    "mergeRefreshIntervalSeconds": '120',
    "githubRateLimitCooldownSeconds": '900',
    "mergePostSummaries": False,
    "mergeShowPrCommits": True,
    "mergeTimelineTimestampMode": "hidden",
    "mergeSidebarWidthPercent": "37",
    "mergeTimelineHeightPercent": "34",
    "kefaniaAutoShareCodexChat": False,
    "kefaniaUseThemeColors": True,
    "kefaniaShowCloseButton": True,
    "kefaniaCloseAfterMerge": False,
    "kefaniaCloseButtonPosition": "left",
    "ludicrousMode": False,
    "chatgptProjectUrl": "",
    "chatgptReviewProjectUrl": "",
    "workspaceSearchAutoReindex": True,
    "hideSCMProgress": True,
    "inlineSuggestions": True,
    "postCommitAction": "none",
    "skipGitHooks": False,
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
    "windowHeading": "",
    "windowName": "",
    "windowShowModifiedStatus": True,
    "windowShowPushingStatus": True,
    "browserGlobeNewTab": False,
    "browserChatgptHome": False,
    "browserHomeUrl": "https://chatgpt.com/",
    "browserSessionCookieDays": "180",
    "graphOpenWorkingFile": True,
    "graphPreferOpenCommit": False,
    "gitGraphRelativeDates": False,
    "aiCommit": True,
    "aiBackend": "ollama",
    "aiCoremlModel": "qwen3.5-2b",
    "aiCoremlLowMemoryModel": "qwen3.5-0.8b",
    "aiCoremlCommand": "~/Library/Application Support/Sweetiebot/ANE/sweetiebot-ane",
    "durableBackgroundCommits": False,
    "placeholderPrefix": DEFAULT_PLACEHOLDER_PREFIX,
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
    "spellcheckChangesEmoji": True,
    "spellcheckPreserveLineBreaks": False,
    "spellcheckDateFormat": "preserve",
    "aiDefaultBranchDescription": True,
    "aiEmojiPriorityRules": True,
    "aiCommitModel": "qwen2.5-coder:7b",
    "spellcheckModel": "qwen2.5:3b",
    "spellcheckThinkingEffort": "default",
    "spellcheckInstructions": "Recognize financial market terminology and proper names, including Instinet. Correct an obvious misspelling only when context identifies the term; do not substitute a different entity.",
    "aiCommitLowMemoryModel": "qwen2.5-coder:3b",
    "aiLowMemoryGiB": "4",
    "aiModelPicker": True,
    "mcpPullRequest": True,
    "prWarningHighlights": False,
    "mcpPrServer": "codex-drafter",
    "mcpPrTool": "github_create_pull_request",
    "codexUsageResetCountdown": False,
    "codexContinueAtReset": False,
    "codexRateLimitSticker": True,
    "codexHideUsageResetTimes": False,
    "codexUsagePieIndicator": True,
    "codexCloudTasks": False,
    "codexResetTimePieIndicator": False,
    "codexHidePromotions": False,
    "codexHideDictation": False,
    "codexShortModelLabels": False,
    "codexHideChatTimestamps": False,
    "codexShowCannon": False,
    "codexComposerLayout": CODEX_LAYOUT_DEFAULT_JSON,
    "codexFlatComposer": False,
    "codexHideAccessLabel": False,
    "codexInlineLocation": True,
    "codexShowQueuedDelete": True,
    "codexShowQueuePause": False,
    "codexInlineQueuedEditing": True,
    "codexClipboardSubmit": True,
    "codexInterruptOnSendClick": True,
    "codexSendWing": True,
    "codexSendBackground": "",
    "codexNewChatDotColor": "",
    "codexSendForeground": "",
    "codexComposerLabelColor": "",
    "codexDropAccent": "",
    "codexNewChatPlaceholder": "",
    "codexFollowUpPlaceholder": "",
    "defaultBranch": "main",
    "remote": "origin",
    "pullRemote": "auto",
}


def _global_config(*args):
    return subprocess.run(
        ["git", "config", "--global", *args],
        capture_output=True, text=True, cwd=Path.home(),
    )


def _read_global_setting(key, *options):
    result = _global_config(*options, "--get", key)
    # Read-only validation and the configurator preview must also work before
    # the installer has migrated the user's preferences.
    if result.returncode == 1 and key.startswith("sweetiebot."):
        result = _global_config(*options, "--get", "scm-toolkit." + key[len("sweetiebot."):])
    return result


def migrate_legacy_git_settings():
    """Move effective scalar preferences, retaining explicit canonical values.

    Copy all missing preferences before deleting any old keys. Git reports the
    origin of each value so cleanup works with both global config locations.
    """
    result = _global_config("--null", "--show-origin", "--get-regexp", r"^scm-toolkit\.")
    if result.returncode == 1:
        return
    if result.returncode != 0:
        raise RuntimeError("Unable to inspect legacy Git settings: " + result.stderr.strip())

    fields = result.stdout.split("\0")
    if fields[-1] != "" or (len(fields) - 1) % 2:
        raise RuntimeError("Unexpected legacy Git configuration format.")
    values = {}
    origins = set()
    for origin, entry in zip(fields[0:-1:2], fields[1:-1:2]):
        key, separator, value = entry.partition("\n")
        if not origin.startswith("file:") or not key.startswith("scm-toolkit."):
            raise RuntimeError("Unexpected legacy Git configuration origin.")
        values[key] = value if separator else "true"
        origins.add((origin[len("file:"):], key))

    for key, value in values.items():
        canonical = "sweetiebot." + key[len("scm-toolkit."):]
        existing = _global_config("--get", canonical)
        if existing.returncode == 0:
            continue
        if existing.returncode != 1:
            raise RuntimeError(f"Unable to inspect {canonical}: {existing.stderr.strip()}")
        saved = _global_config("--replace-all", canonical, value)
        if saved.returncode != 0:
            raise RuntimeError(f"Unable to migrate {canonical}: {saved.stderr.strip()}")

    for filename, key in sorted(origins):
        removed = subprocess.run(
            ["git", "config", "--file", filename, "--unset-all", key],
            capture_output=True, text=True, cwd=Path.home(),
        )
        if removed.returncode not in (0, 5):
            raise RuntimeError(f"Unable to remove migrated {key}: {removed.stderr.strip()}")


def read_git_bool(key, default):
    try:
        result = _read_global_setting(key, "--type=bool")
    except FileNotFoundError:
        return default

    if result.returncode == 1:
        return default
    if result.returncode != 0:
        raise RuntimeError(f"Unable to read global Git config key {key}: {result.stderr.strip()}")
    return result.stdout.strip() == "true"


def read_git_string(key, default, preserve_empty=False):
    try:
        result = _read_global_setting(key)
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
                value = "Message" if read_git_bool("sweetiebot.short-placeholder", True) else ""
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
            "left" if read_git_bool("sweetiebot.kefania-close-button-left", True) else "right"
        )
    elif new_position not in {"left", "middle", "right"}:
        settings["kefaniaCloseButtonPosition"] = "left"
    if settings["squashTrailerSeparatorStyle"] not in {"underscores", "hyphens", "none"}:
        settings["squashTrailerSeparatorStyle"] = "underscores"
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
    "branchPicker": "sweetiebot.branch-picker",
    "horizontalBranchSelector": "sweetiebot.horizontal-branch-selector",
    "messageBarLayout": "sweetiebot.message-bar-layout",
    "ponyBranch": "sweetiebot.pony-branch",
    "branchNameDisabledPacks": "sweetiebot.branch-name-disabled-packs",
    "branchCustomNames": "sweetiebot.branch-custom-names",
    "branchNameImports": "sweetiebot.branch-name-imports",
    "messagePlaceholder": "sweetiebot.message-placeholder",
    "commitButtonLabel": "sweetiebot.commit-button-label",
    "commitAndSendButtonLabel": "sweetiebot.commit-and-send-button-label",
    "sourceControlLabel": "sweetiebot.source-control-label",
    "nativeAppUpdateMode": "sweetiebot.native-app-update-mode",
    "nativeExtensionAutoCheckUpdates": "sweetiebot.native-extension-auto-check-updates",
    "nativeExtensionAutoUpdate": "sweetiebot.native-extension-auto-update",
    "automaticAppRepair": "sweetiebot.automatic-app-repair",
    "openPanelOnStartup": "sweetiebot.open-panel-on-startup",
    "notificationPosition": "sweetiebot.notification-position",
    "workspaceSearchActivityBar": "sweetiebot.workspace-search-activity-bar",
    "workspaceSearchLabel": "sweetiebot.workspace-search-label",
    "workspaceSearchPlaceholder": "sweetiebot.workspace-search-placeholder",
    "workspaceSearchAskOllama": "sweetiebot.workspace-search-ask-ollama",
    "workspaceSearchChatModel": "sweetiebot.workspace-search-chat-model",
    "workspaceSearchEmbeddingModel": "sweetiebot.workspace-search-embedding-model",
    "filledButtons": "sweetiebot.filled-buttons",
    "commitAndPush": "sweetiebot.commit-and-push",
    "branchCleanup": "sweetiebot.branch-cleanup",
    "autocompleteToggle": "sweetiebot.autocomplete-toggle",
    "autoPublishToggle": "sweetiebot.auto-publish-toggle",
    "autoPublishNewBranches": "sweetiebot.auto-publish-new-branches",
    "automaticBranchCleanup": "sweetiebot.automatic-branch-cleanup",
    "automaticWorkspaceCleanup": "sweetiebot.automatic-workspace-cleanup",
    "pullRequestAutoRefresh": "sweetiebot.pull-request-auto-refresh",
    "pullRequestRefreshIntervalSeconds": "sweetiebot.pull-request-refresh-interval-seconds",
    "pullRequestQuickMerge": "sweetiebot.pull-request-quick-merge",
    "autoPublishPullRequests": "sweetiebot.auto-publish-pull-requests",
    "filterSyncCommitSummaries": "sweetiebot.filter-sync-commit-summaries",
    "squashOmitBulletsForEmojiTitles": "sweetiebot.squash-omit-bullets-for-emoji-titles",
    "squashTrailerSeparatorStyle": "sweetiebot.squash-trailer-separator-style",
    "mergeAutoRefresh": "sweetiebot.merge-auto-refresh",
    "mergeRefreshIntervalSeconds": "sweetiebot.merge-refresh-interval-seconds",
    "githubRateLimitCooldownSeconds": "sweetiebot.github-rate-limit-cooldown-seconds",
    "mergePostSummaries": "sweetiebot.merge-post-summaries",
    "mergeShowPrCommits": "sweetiebot.merge-show-pr-commits",
    "mergeTimelineTimestampMode": "sweetiebot.merge-timeline-timestamp-mode",
    "mergeSidebarWidthPercent": "sweetiebot.merge-sidebar-width-percent",
    "mergeTimelineHeightPercent": "sweetiebot.merge-timeline-height-percent",
    "kefaniaAutoShareCodexChat": "sweetiebot.kefania-auto-share-codex-chat",
    "kefaniaUseThemeColors": "sweetiebot.kefania-use-theme-colors",
    "kefaniaShowCloseButton": "sweetiebot.kefania-show-close-button",
    "kefaniaCloseAfterMerge": "sweetiebot.kefania-close-after-merge",
    "kefaniaCloseButtonPosition": "sweetiebot.kefania-close-button-position",
    "ludicrousMode": "sweetiebot.ludicrous-mode",
    "chatgptProjectUrl": "sweetiebot.chatgpt-project-url",
    "chatgptReviewProjectUrl": "sweetiebot.chatgpt-review-project-url",
    "workspaceSearchAutoReindex": "sweetiebot.workspace-search-auto-reindex",
    "hideSCMProgress": "sweetiebot.hide-scm-progress",
    "inlineSuggestions": "sweetiebot.inline-suggestions",
    "postCommitAction": "sweetiebot.post-commit-action",
    "skipGitHooks": "sweetiebot.skip-git-hooks",
    "workspaceSearchOllamaUrl": "sweetiebot.workspace-search-ollama-url",
    "workspaceSearchMode": "sweetiebot.workspace-search-mode",
    "workspaceSearchResultLimit": "sweetiebot.workspace-search-result-limit",
    "workspaceSearchMaxFiles": "sweetiebot.workspace-search-max-files",
    "workspaceSearchMaxFileSizeMB": "sweetiebot.workspace-search-max-file-size-mb",
    "workspaceSearchExclude": "sweetiebot.workspace-search-exclude",
    "codexCoauthor": "sweetiebot.codex-coauthor",
    "codexCoauthorName": "sweetiebot.codex-coauthor-name",
    "codexCoauthorEmail": "sweetiebot.codex-coauthor-email",
    "codexCommitContext": "sweetiebot.codex-commit-context",
    "codexKeepAwake": "sweetiebot.codex-keep-awake",
    "codexWindowLabel": "sweetiebot.codex-window-label",
    "hideIncomingSyncCount": "sweetiebot.hide-incoming-sync-count",
    "hideOutgoingSyncCount": "sweetiebot.hide-outgoing-sync-count",
    "hideIncomingSyncArrow": "sweetiebot.hide-incoming-sync-arrow",
    "hideOutgoingSyncArrow": "sweetiebot.hide-outgoing-sync-arrow",
    "incomingSyncLabel": "sweetiebot.incoming-sync-label",
    "outgoingSyncLabel": "sweetiebot.outgoing-sync-label",
    "blankStateRefresh": "sweetiebot.blank-state-refresh",
    "autoPullClean": "sweetiebot.auto-pull-clean",
    "cloudRepositorySync": "sweetiebot.cloud-repository-sync",
    "cmdClickCloseOthers": "sweetiebot.cmd-click-close-others",
    "compactWindowButton": "sweetiebot.compact-window-button",
    "newWorkspaceWindowButton": "sweetiebot.new-workspace-window-button",
    "windowHeading": "sweetiebot.window-heading",
    "windowName": "sweetiebot.window-name",
    "windowShowModifiedStatus": "sweetiebot.window-show-modified-status",
    "windowShowPushingStatus": "sweetiebot.window-show-pushing-status",
    "browserGlobeNewTab": "sweetiebot.browser-globe-new-tab",
    "browserChatgptHome": "sweetiebot.browser-chatgpt-home",
    "browserHomeUrl": "sweetiebot.browser-home-url",
    "browserSessionCookieDays": "sweetiebot.browser-session-cookie-days",
    "graphOpenWorkingFile": "sweetiebot.graph-open-working-file",
    "graphPreferOpenCommit": "sweetiebot.graph-prefer-open-commit",
    "gitGraphRelativeDates": "sweetiebot.git-graph-relative-dates",
    "aiCommit": "sweetiebot.ai-commit",
    "aiBackend": "sweetiebot.ai-backend",
    "aiCoremlModel": "sweetiebot.ai-coreml-model",
    "aiCoremlLowMemoryModel": "sweetiebot.ai-coreml-low-memory-model",
    "aiCoremlCommand": "sweetiebot.ai-coreml-command",
    "durableBackgroundCommits": "sweetiebot.durable-background-commits",
    "placeholderPrefix": "sweetiebot.placeholder-prefix",
    "aiDetailedCommitStyle": "sweetiebot.ai-detailed-commit-style",
    "aiTitleExplanations": "sweetiebot.ai-title-explanations",
    "aiCommitFallback": "sweetiebot.ai-commit-fallback",
    "aiCommitRequestTimeoutSeconds": "sweetiebot.ai-commit-request-timeout-seconds",
    "aiCommitAttempts": "sweetiebot.ai-commit-attempts",
    "normalizeStagedWhitespace": "sweetiebot.normalize-staged-whitespace",
    "spellcheckManualCommit": "sweetiebot.spellcheck-preview",
    "draftSpellcheckAction": "sweetiebot.draft-spellcheck-action",
    "draftSpellcheckDelaySeconds": "sweetiebot.draft-spellcheck-delay-seconds",
    "draftSpellcheckStyle": "sweetiebot.draft-spellcheck-style",
    "draftSpellcheckVocabulary": "sweetiebot.draft-spellcheck-vocabulary",
    "draftSpellcheckGuidance": "sweetiebot.draft-spellcheck-guidance",
    "draftCommitEmoji": "sweetiebot.draft-commit-emoji",
    "postCommitSpellcheck": "sweetiebot.post-commit-spellcheck",
    "spellcheckChangesEmoji": "sweetiebot.spellcheck-changes-emoji",
    "spellcheckPreserveLineBreaks": "sweetiebot.spellcheck-preserve-line-breaks",
    "spellcheckDateFormat": "sweetiebot.spellcheck-date-format",
    "aiDefaultBranchDescription": "sweetiebot.ai-default-branch-description",
    "aiEmojiPriorityRules": "sweetiebot.ai-emoji-priority-rules",
    "aiCommitModel": "sweetiebot.ai-commit-model",
    "spellcheckModel": "sweetiebot.spellcheck-model",
    "spellcheckThinkingEffort": "sweetiebot.spellcheck-thinking-effort",
    "spellcheckInstructions": "sweetiebot.spellcheck-instructions",
    "aiCommitLowMemoryModel": "sweetiebot.ai-commit-low-memory-model",
    "aiLowMemoryGiB": "sweetiebot.ai-low-memory-gib",
    "aiModelPicker": "sweetiebot.ai-model-picker",
    "mcpPullRequest": "sweetiebot.mcp-pull-request",
    "prWarningHighlights": "sweetiebot.pr-warning-highlights",
    "mcpPrServer": "sweetiebot.mcp-pr-server",
    "mcpPrTool": "sweetiebot.mcp-pr-tool",
    "codexUsageResetCountdown": "sweetiebot.codex-usage-reset-countdown",
    "codexContinueAtReset": "sweetiebot.codex-continue-at-reset",
    "codexRateLimitSticker": "sweetiebot.codex-rate-limit-sticker",
    "codexHideUsageResetTimes": "sweetiebot.codex-hide-usage-reset-times",
    "codexUsagePieIndicator": "sweetiebot.codex-usage-pie-indicator",
    "codexCloudTasks": "sweetiebot.codex-cloud-tasks",
    "codexResetTimePieIndicator": "sweetiebot.codex-reset-time-pie-indicator",
    "codexHidePromotions": "sweetiebot.codex-hide-promotions",
    "codexHideDictation": "sweetiebot.codex-hide-dictation",
    "codexShortModelLabels": "sweetiebot.codex-short-model-labels",
    "codexHideChatTimestamps": "sweetiebot.codex-hide-chat-timestamps",
    "codexShowCannon": "sweetiebot.codex-show-cannon",
    "codexComposerLayout": "sweetiebot.codex-composer-layout",
    "codexFlatComposer": "sweetiebot.codex-flat-composer",
    "codexHideAccessLabel": "sweetiebot.codex-hide-access-label",
    "codexInlineLocation": "sweetiebot.codex-inline-location",
    "codexShowQueuedDelete": "sweetiebot.codex-show-queued-delete",
    "codexShowQueuePause": "sweetiebot.codex-show-queue-pause",
    "codexInlineQueuedEditing": "sweetiebot.codex-inline-queued-editing",
    "codexClipboardSubmit": "sweetiebot.codex-clipboard-submit",
    "codexInterruptOnSendClick": "sweetiebot.codex-interrupt-on-send-click",
    "codexSendWing": "sweetiebot.codex-send-wing",
    "codexSendBackground": "sweetiebot.codex-send-background",
    "codexNewChatDotColor": "sweetiebot.codex-new-chat-dot-color",
    "codexSendForeground": "sweetiebot.codex-send-foreground",
    "codexComposerLabelColor": "sweetiebot.codex-composer-label-color",
    "codexDropAccent": "sweetiebot.codex-drop-accent",
    "codexNewChatPlaceholder": "sweetiebot.codex-new-chat-placeholder",
    "codexFollowUpPlaceholder": "sweetiebot.codex-follow-up-placeholder",
    "defaultBranch": "sweetiebot.default-branch",
    "remote": "sweetiebot.remote",
    "pullRemote": "sweetiebot.pull-remote",
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
        "windowHeading": "windowHeading",
        "windowName": "windowName",
        "windowShowModifiedStatus": "windowShowModifiedStatus",
        "windowShowPushingStatus": "windowShowPushingStatus",
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
        "gitGraphRelativeDates": "gitGraphRelativeDates",
        "pullRequestAutoRefresh": "pullRequestAutoRefresh",
        "prWarningHighlights": "prWarningHighlights",
        "pullRequestRefreshIntervalSeconds": "pullRequestRefreshIntervalSeconds",
        "pullRequestQuickMerge": "pullRequestQuickMerge",
        "autoPublishPullRequests": "autoPublishPullRequests",
        "filterSyncCommitSummaries": "filterSyncCommitSummaries",
        "squashOmitBulletsForEmojiTitles": "squashOmitBulletsForEmojiTitles",
        "squashTrailerSeparatorStyle": "squashTrailerSeparatorStyle",
        "mergeAutoRefresh": "mergeAutoRefresh",
        "mergeRefreshIntervalSeconds": "mergeRefreshIntervalSeconds",
        "githubRateLimitCooldownSeconds": "githubRateLimitCooldownSeconds",
        "mergePostSummaries": "mergePostSummaries",
        "mergeShowPrCommits": "mergeShowPrCommits",
        "mergeTimelineTimestampMode": "mergeTimelineTimestampMode",
        "mergeSidebarWidthPercent": "mergeSidebarWidthPercent",
        "mergeTimelineHeightPercent": "mergeTimelineHeightPercent",
        "kefaniaAutoShareCodexChat": "kefaniaAutoShareCodexChat",
        "kefaniaUseThemeColors": "kefaniaUseThemeColors",
        "kefaniaShowCloseButton": "kefaniaShowCloseButton",
        "kefaniaCloseAfterMerge": "kefaniaCloseAfterMerge",
        "kefaniaCloseButtonPosition": "kefaniaCloseButtonPosition",
        "chatgptProjectUrl": "chatgptProjectUrl",
        "chatgptReviewProjectUrl": "chatgptReviewProjectUrl",
        "spellcheckDateFormat": "spellcheckDateFormat",
        "codexKeepAwake": "codexKeepAwake",
        "codexContinueAtReset": "codexContinueAtReset",
        "durableBackgroundCommits": "durableBackgroundCommits",
    },
    "appUpdateSettings": {"mode": "nativeAppUpdateMode"},
    "extensionUpdateSettings": {"autoCheckUpdates": "nativeExtensionAutoCheckUpdates", "autoUpdate": "nativeExtensionAutoUpdate"},
    "workbenchNotificationSettings": {"position": "notificationPosition"},
    "editorSettings": {"inlineSuggest.enabled": "inlineSuggestions"},
    "gitSettings": {"postCommitCommand": "postCommitAction"},
}
