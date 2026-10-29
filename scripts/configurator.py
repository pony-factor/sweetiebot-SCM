#!/usr/bin/env python3
"""Local, dependency-free web configurator for the SCM toolkit."""

from __future__ import annotations

import html
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from toolkit_settings import load_settings, VSCODE_SETTINGS
from commit_diagnostics_dashboard import (
    DIAGNOSTICS_PANEL, DIAGNOSTICS_SCRIPT, DIAGNOSTICS_STYLE, read_diagnostics,
)
from commit_hotkey import read_commit_hotkey, update_commit_hotkey
from codex_colors import validate_color
import codex_sticker
from branch_names import load_catalog, merge_catalog, parse_imported_packs, parse_name_list, parse_pack_id_list
from local_setup import (
    configure_signing_key,
    generate_signing_key,
    load_commit_instructions,
    open_signing_key_manager,
    save_commit_instructions,
    signing_status,
)
from message_bar import MESSAGE_BAR_VISIBILITY_SETTINGS, parse_message_bar_layout, serialize_message_bar_layout
from message_bar_configurator import MESSAGE_BAR_SCRIPT, MESSAGE_BAR_STYLE, render_message_bar_control
from codex_composer_layout import CONFIG_SCRIPT as CODEX_LAYOUT_SCRIPT, CONFIG_STYLE as CODEX_LAYOUT_STYLE, render_control as render_codex_layout_control, serialize_layout as serialize_codex_layout
from window_title_configurator import WINDOW_TITLE_SCRIPT, WINDOW_TITLE_STYLE, render_heading
from github_apps_ui import APP_PANEL, APP_SCRIPT
from github_apps import app_status, save_app, save_mode, check_connection


OLLAMA_URL = "http://127.0.0.1:11434"
MAX_FORM_BYTES = 512 * 1024
STICKER_UPLOAD_LIMIT = codex_sticker.MAX_STICKER_BYTES

STICKER_SCRIPT = r"""
const stickerPicker = document.getElementById('sticker-upload');
const stickerReset = document.getElementById('sticker-reset');
const stickerStatus = document.getElementById('sticker-status');
stickerPicker?.addEventListener('change', async () => {
  const file = stickerPicker.files?.[0];
  if (!file) return;
  stickerPicker.disabled = true;
  stickerReset.disabled = true;
  stickerStatus.textContent = 'Caching image locally…';
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('Choose an image under 2 MB.');
    const response = await fetch('/sticker-upload' + location.search, {
      method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: file
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to cache the image.');
    stickerStatus.textContent = 'Cached privately. Rebuild and reload Codex to display it.';
  } catch (error) {
    stickerStatus.textContent = 'Image not saved: ' + error.message;
  } finally {
    stickerPicker.value = '';
    stickerPicker.disabled = false;
    stickerReset.disabled = false;
  }
});
stickerReset?.addEventListener('click', async () => {
  stickerPicker.disabled = true;
  stickerReset.disabled = true;
  try {
    const response = await fetch('/sticker-reset' + location.search, {method: 'POST'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to reset sticker.');
    stickerStatus.textContent = 'Bundled Twilight image selected. Rebuild and reload Codex.';
  } catch (error) {
    stickerStatus.textContent = 'Reset failed: ' + error.message;
  } finally {
    stickerPicker.disabled = false;
    stickerReset.disabled = false;
  }
});
"""

COMMIT_HOTKEY_STYLE = """
.hotkey-setting{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);align-items:center}
.hotkey-actions{display:grid;grid-template-columns:max-content max-content max-content minmax(0,1fr);align-items:center;gap:8px;min-width:0}
.hotkey-value{font:600 13px ui-monospace,monospace;background:var(--bg);padding:7px 11px;border:1px solid var(--line);border-radius:6px;white-space:nowrap}
.hotkey-actions button{white-space:nowrap}
.hotkey-status{grid-column:1/-1;min-width:0;overflow-wrap:anywhere;color:var(--muted);font-size:12px}
.hotkey-status.error-state{color:#ffb3ad}
@media(max-width:1080px){.hotkey-setting{grid-template-columns:minmax(0,1fr);gap:8px}}
"""
PERMISSIONS_SCRIPT = r"""
document.getElementById('codex-permissions')?.addEventListener('click', async () => {
  const status = document.getElementById('codex-permissions-status');
  try {
    const response = await fetch('/codex-permissions' + location.search, {method:'POST'});
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    status.textContent = 'Choose permissions in the Codex menu.';
  } catch (error) { status.textContent = error.message; }
});
"""


COMMIT_HOTKEY_SCRIPT = r"""
const hotkeyNames = {
  Space:'space', Enter:'enter', Tab:'tab', Escape:'escape',
  Backspace:'backspace', Delete:'delete', Home:'home', End:'end',
  PageUp:'pageup', PageDown:'pagedown', Insert:'insert',
  ArrowLeft:'left', ArrowRight:'right', ArrowUp:'up', ArrowDown:'down',
  Backquote:'backquote', Minus:'minus', Equal:'equal',
  BracketLeft:'bracketleft', BracketRight:'bracketright',
  Backslash:'backslash', Semicolon:'semicolon', Quote:'quote',
  Comma:'comma', Period:'period', Slash:'slash'
};
let activeStopHotkey = null;
function setupCommitHotkey(prefix, command) {
  const hotkeyChange = document.getElementById(prefix + '-change');
  const hotkeyReset = document.getElementById(prefix + '-reset');
  const hotkeyValue = document.getElementById(prefix + '-value');
  const hotkeyStatus = document.getElementById(prefix + '-status');
  if (!hotkeyChange || !hotkeyReset || !hotkeyValue || !hotkeyStatus) return;
  let hotkeyListening = false;
  function finishHotkeyRecording() {
    hotkeyListening = false;
    document.removeEventListener('keydown', captureCommitHotkey, true);
    hotkeyChange.textContent = 'Change';
    if (activeStopHotkey === finishHotkeyRecording) activeStopHotkey = null;
  }
  async function saveCommitHotkey(key) {
    hotkeyChange.disabled = true;
    hotkeyReset.disabled = true;
    hotkeyStatus.classList.remove('error-state');
    hotkeyStatus.textContent = 'Saving…';
    try {
      const response = await fetch('/commit-hotkey' + location.search, {
        method:'POST', body:new URLSearchParams({key, command})
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save shortcut.');
      hotkeyValue.textContent = result.key || 'Unbound';
      hotkeyStatus.textContent = 'Saved to VS Code user keybindings.';
    } catch (error) {
      hotkeyStatus.textContent = error.message;
      hotkeyStatus.classList.add('error-state');
    } finally {
      hotkeyChange.disabled = false;
      hotkeyReset.disabled = false;
    }
  }
  function captureCommitHotkey(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      finishHotkeyRecording();
      hotkeyStatus.textContent = 'Recording cancelled.';
      return;
    }
    if (/^(Shift|Control|Alt|Meta|OS)$/.test(event.key) || event.repeat) return;
    let key = hotkeyNames[event.code];
    if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase();
    if (!key && /^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
    if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code.toLowerCase();
    if (!key) {
      hotkeyStatus.textContent = 'Unsupported key. Try a letter, number, function, or navigation key.';
      return;
    }
    const mods = [];
    if (event.ctrlKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.shiftKey) mods.push('shift');
    if (event.metaKey) mods.push('cmd');
    finishHotkeyRecording();
    void saveCommitHotkey([...mods, key].join('+'));
  }
  hotkeyChange.addEventListener('click', () => {
    if (hotkeyListening) { finishHotkeyRecording(); return; }
    if (activeStopHotkey) activeStopHotkey();
    hotkeyListening = true;
    activeStopHotkey = finishHotkeyRecording;
    hotkeyChange.textContent = 'Cancel';
    hotkeyStatus.textContent = 'Press the desired key combination. Escape cancels.';
    hotkeyStatus.classList.remove('error-state');
    document.addEventListener('keydown', captureCommitHotkey, true);
  });
  hotkeyReset.addEventListener('click', () => {
    finishHotkeyRecording();
    void saveCommitHotkey('');
  });
  window.addEventListener('blur', () => {
    if (hotkeyListening) {
      finishHotkeyRecording();
      hotkeyStatus.textContent = 'Recording cancelled.';
    }
  });
}
setupCommitHotkey('commit-hotkey', 'sweetiebot.commit');
setupCommitHotkey('codex-commit-hotkey', 'sweetiebot.commitWithCodex');
"""
def _commit_hotkey_control(
    key: str | None,
    *,
    prefix: str = "commit-hotkey",
    label: str = "Commit hotkey",
    description: str = ("Run the same action as the Source Control Commit button. "
                        "Unbound by default; Reset removes the assignment."),
) -> str:
    available = key is not None
    shown = html.escape(key or "Unbound")
    disabled = "" if available else " disabled"
    hint = ("Only shortcuts explicitly saved by you are active; browser/system "
            "shortcuts may still take precedence." if available else
            "Open this page from Sweetiebot in VS Code to edit its shortcut.")
    return (
        f'<div class="setting hotkey-setting"><span><strong>{html.escape(label)}</strong>'
        f'<small>{html.escape(description)}</small></span>'
        '<div class="hotkey-actions">'
        f'<output id="{prefix}-value" class="hotkey-value">{shown}</output>'
        f'<button type="button" id="{prefix}-change"{disabled}>Change</button>'
        f'<button type="button" id="{prefix}-reset"{disabled}>Reset</button>'
        f'<small id="{prefix}-status" class="hotkey-status" role="status" aria-live="polite">'
        f'{html.escape(hint)}</small></div></div>'
    )


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
    Setting("pullRequestAutoRefresh", "scm-toolkit.pull-request-auto-refresh", "Refresh active Pull Requests tab", "Refresh only while visible and focused; pause after GitHub rate limits.", "GitHub"),
    Setting("pullRequestRefreshIntervalSeconds", "scm-toolkit.pull-request-refresh-interval-seconds", "Pull-request refresh interval (seconds)", "Default 120 seconds; choose 30–3600. Manual refresh is unaffected.", "GitHub", "integer", minimum=30, maximum=3600),
    Setting("pullRequestQuickMerge", "scm-toolkit.pull-request-quick-merge", "Quick squash-merge button", "Show a merge button beside GitHub pull requests to squash and merge into main without opening them. Requires the GitHub CLI.", "GitHub"),
        Setting("chatgptProjectUrl", "scm-toolkit.chatgpt-project-url", "Shared ChatGPT project", "Project for PR/merge chats and pony research, also inherited by native Spellcheck Only and manual commit-title suggestions when no dedicated review Project is set. Blank uses regular chats.", "GitHub", "chatgpt_project_url"),
        Setting("chatgptReviewProjectUrl", "scm-toolkit.chatgpt-review-project-url", "ChatGPT Project for commit titles and Spellcheck Only", "Optional dedicated Project for manual ChatGPT commit-title suggestions and native Spellcheck Only. Blank inherits the shared Project or regular chats. Automatic background jobs still use Ollama.", "GitHub", "chatgpt_project_url"),
    Setting("branchPicker", "scm-toolkit.branch-picker", "Branch picker", "Show the current branch in the commit-message row.", "Message bar"),
    Setting("horizontalBranchSelector", "scm-toolkit.horizontal-branch-selector", "Horizontal branch selector", "Click the branch box beside the message field to open horizontal branch options in the bottom panel. Turn off to open the native branch picker instead.", "Source control"),
    Setting("messageBarLayout", "scm-toolkit.message-bar-layout", "Message bar layout", "Arrange the message-bar buttons and add as many separators as you need.", "Message bar", "message_bar"),
    Setting("ponyBranch", "scm-toolkit.pony-branch", "Random branch button", "Create a freshly synced branch using the configured branch-name pool.", "Message bar"),
    Setting("messagePlaceholder", "scm-toolkit.message-placeholder", "Message placeholder", "Text shown in the Source Control commit-message box. Leave blank to use VS Code\'s default.", "Message bar", "optional_text"),
    Setting("commitButtonLabel", "scm-toolkit.commit-button-label", "Commit button label", "Text shown on the primary Source Control commit action.", "Message bar", "text"),
    Setting("commitAndSendButtonLabel", "scm-toolkit.commit-and-send-button-label", "Commit and send button label", "Text shown on the primary commit action when git.postCommitCommand is push.", "Message bar", "text"),
    Setting("sourceControlLabel", "scm-toolkit.source-control-label", "Source Control label", "Override the Source Control view label shown in the app bar.", "Source control", "text"),
    Setting("nativeAppUpdateMode", "scm-toolkit.native-app-update-mode", "VS Code app updates", "Use default for automatic update checks, start to check only at startup, manual to check on demand, or none to disable updates. VS Code keeps its normal update notices.", "Initialization", "select", ("default", "start", "manual", "none")),
    Setting("nativeExtensionAutoCheckUpdates", "scm-toolkit.native-extension-auto-check-updates", "Automatically check for extension updates", "Use VS Code's built-in checks for installed extension updates.", "Initialization"),
    Setting("nativeExtensionAutoUpdate", "scm-toolkit.native-extension-auto-update", "Automatically update extensions", "Let VS Code install extension updates automatically. Per-extension overrides and administrator policies still apply.", "Initialization"),
    Setting("automaticAppRepair", "scm-toolkit.automatic-app-repair", "Automatically update and restore app customizations", "Check for Sweetie Bot updates and restore patches after VS Code or extension updates; automatically reload the focused window when ready.", "Initialization"),
    Setting("openPanelOnStartup", "scm-toolkit.open-panel-on-startup", "Open Sweetie Bot on startup", "Open Sweetie Bot / Source Control automatically when each VS Code window starts.", "Initialization"),
    Setting("notificationPosition", "scm-toolkit.notification-position", "Notification position", "Choose where VS Code notification toasts and the Notification Center appear.", "Source control", "select", ("bottom-left", "bottom-right", "top-right")),
    Setting("filledButtons", "scm-toolkit.filled-buttons", "Accent-filled buttons", "Fill the branch and Commit controls with the theme accent instead of outlining them.", "Source control"),
    Setting("commitAndPush", "scm-toolkit.commit-and-push", "Show push checkbox", "Show the push-after-committing checkbox beside the message field.", "Message bar"),
    Setting("branchCleanup", "scm-toolkit.branch-cleanup", "Branch cleanup", "Show guarded local-branch cleanup controls.", "Message bar"),
    Setting("autocompleteToggle", "scm-toolkit.autocomplete-toggle", "Inline code completion", "Show the inline code completion switch in the SCM message row.", "Message bar"),
    Setting("autoPublishToggle", "scm-toolkit.auto-publish-toggle", "Auto-publish toggle", "Show the cloud control that publishes newly selected local branches to the configured remote.", "Message bar"),
    Setting("autoPublishNewBranches", "scm-toolkit.auto-publish-new-branches", "Automatically publish new branches", "Publish newly selected local branches to the configured remote. Saved as your VS Code user preference; the cloud control reflects this setting.", "Source control"),
    Setting("automaticBranchCleanup", "scm-toolkit.automatic-branch-cleanup", "Automatically clean merged branches", "Check for merged branches on startup and every ten minutes, and remove eligible local branches.", "Source control"),
    Setting("automaticWorkspaceCleanup", "scm-toolkit.automatic-workspace-cleanup", "Automatically clean merged workspaces", "Remove only inactive Sweetiebot-managed independent workspaces whose pull requests are verified merged into main; preserve dirty files, unmerged branches, and unpublished commits.", "Source control"),
    Setting("hideSCMProgress", "scm-toolkit.hide-scm-progress", "Hide Source Control progress bar", "Hide the progress animation during Git operations and background refreshes.", "Source control"),
    Setting("inlineSuggestions", "scm-toolkit.inline-suggestions", "Inline suggestions", "Enable inline suggestions, including in the commit-message editor.", "Source control"),
    Setting("postCommitAction", "scm-toolkit.post-commit-action", "Push after committing", "Checked pushes after committing; unchecked does nothing.", "Message bar", "push_checkbox"),
    Setting("codexCoauthor", "scm-toolkit.codex-coauthor", "Co-author commit button", "Show the attributed commit action.", "Message bar"),
    Setting("codexCoauthorName", "scm-toolkit.codex-coauthor-name", "Commit co-author name", "Display name written into the Co-authored-by trailer; defaults to Codex.", "Message bar", "coauthor_name"),
    Setting("codexCoauthorEmail", "scm-toolkit.codex-coauthor-email", "Commit co-author email", "Email in the Co-authored-by trailer. To link a GitHub account, enter an address associated with that account.", "Message bar", "coauthor_email"),
    Setting("codexCommitContext", "scm-toolkit.codex-commit-context", "Local commit messages from Codex text", "When the co-author commit message is blank, use this window's current conversation and staged changes with local Ollama. Codex keeps running.", "Source control"),
    Setting("codexKeepAwake", "scm-toolkit.codex-keep-awake", "Keep awake while Codex works", "Keep macOS and its display awake and postpone the automatic screensaver while Codex tasks are running. Enabled by default; VS Code's Codex Keep Awake setting can override it.", "Codex"),
    Setting("codexWindowLabel", "scm-toolkit.codex-window-label", "Codex window label", "Rename the Codex sidebar and its Activity Bar / secondary sidebar title, e.g. CelestAI. Use Codex to restore its original label; apply with app repair and reload VS Code.", "Codex", "text"),
    Setting("hideIncomingSyncCount", "scm-toolkit.hide-incoming-sync-count", "Hide incoming count", "Remove the incoming commit count from Sync.", "Source control"),
    Setting("hideOutgoingSyncCount", "scm-toolkit.hide-outgoing-sync-count", "Hide outgoing count", "Remove the outgoing commit count from Sync.", "Source control"),
    Setting("hideIncomingSyncArrow", "scm-toolkit.hide-incoming-sync-arrow", "Hide incoming sync arrow", "Hide the down arrow in the Source Control Sync button while preserving counts, labels, and sync behavior.", "Source control"),
    Setting("hideOutgoingSyncArrow", "scm-toolkit.hide-outgoing-sync-arrow", "Hide outgoing sync arrow", "Hide the up arrow in the Source Control Sync button while preserving counts, labels, and sync behavior.", "Source control"),
    Setting("incomingSyncLabel", "scm-toolkit.incoming-sync-label", "Incoming sync label", "Custom name beside the incoming (down-arrow) count in Sync Changes. Leave blank for the native display.", "Source control", "optional_text"),
    Setting("outgoingSyncLabel", "scm-toolkit.outgoing-sync-label", "Outgoing sync label", "Custom name beside the outgoing (up-arrow) count in Sync Changes. Leave blank for the native display.", "Source control", "optional_text"),
    Setting("blankStateRefresh", "scm-toolkit.blank-state-refresh", "Refresh blank repositories", "Refresh clean repositories so their first new change appears quickly.", "Source control"),
    Setting("autoPullClean", "scm-toolkit.auto-pull-clean", "Automatically sync", "Fetch remote updates and fast-forward branches when possible. Runs independently of the push-after-committing checkbox.", "Source control"),
    Setting("cloudRepositorySync", "scm-toolkit.cloud-repository-sync", "Sync recent repositories every 15 minutes", "Update existing local main checkouts with upstream commits from the past seven days, even when VS Code is closed. Skips local changes and divergent branches.", "GitHub"),
    Setting("graphOpenWorkingFile", "scm-toolkit.graph-open-working-file", "Open graph files from working tree", "Make Source Control Graph Open File target the checked-out working-tree file instead of the selected commit snapshot.", "Source control"),
    Setting("normalizeStagedWhitespace", "scm-toolkit.normalize-staged-whitespace", "Normalize line endings and whitespace", "Remove trailing spaces on added lines and ensure exactly one final newline in eligible staged text files, preserving LF or CRLF. Applies to ordinary commits and Commit with Codex, including typed messages. Disable to preserve staged file formatting.", "Source control"),
    Setting("compactWindowButton", "scm-toolkit.compact-window-button", "Show compact-window button", "Show the title-bar button that switches between compact and restored window sizes.", "Window"),
    Setting("newWorkspaceWindowButton", "scm-toolkit.new-workspace-window-button", "Show new-workspace-window button", "Show the title-bar button that opens the same repository folders in a new workspace window.", "Window"),
    Setting("windowHeading", "scm-toolkit.window-heading", "Title-bar heading", "Leave blank to follow VS Code's window.title setting. Use VS Code title variables, e.g. ${rootName} (${activeRepositoryBranchName}). This changes the visible heading independently of the window name.", "Window", "optional_text"),
    Setting("windowName", "scm-toolkit.window-name", "Window name", "Name shown in macOS and window switchers. Leave blank to follow VS Code's window.title setting. Use the same title variables as the heading; Pushing is added automatically while publication is pending.", "Window", "optional_text"),
    Setting("windowShowModifiedStatus", "scm-toolkit.window-show-modified-status", "Show modified editor status", "Allow VS Code to display Modified or other active editor state in window titles. Disable to hide this status.", "Window"),
    Setting("windowShowPushingStatus", "scm-toolkit.window-show-pushing-status", "Show pushing status", "Append Pushing while a background push is pending. Disable to hide the label without changing the actual push.", "Window"),
    Setting("cmdClickCloseOthers", "scm-toolkit.cmd-click-close-others", "Cmd-click closes other tabs", "Hold Command while clicking a tab's X to keep that tab open and close the other editors in its group.", "Browser"),
    Setting("browserGlobeNewTab", "scm-toolkit.browser-globe-new-tab", "Globe opens a new browser tab", "Click the title-bar globe to open a new Integrated Browser tab directly. Turn off to show the browser URL or tab picker.", "Browser"),
    Setting("browserChatgptHome", "scm-toolkit.browser-chatgpt-home", "Custom URL for blank browser tabs", "Open blank Integrated Browser tabs at the URL below while preserving explicit URLs.", "Browser"),
    Setting("browserHomeUrl", "scm-toolkit.browser-home-url", "Blank browser tab URL", "Destination for new blank browser tabs. Leave blank to use ChatGPT.", "Browser", "browser_url"),
    Setting("workspaceSearchActivityBar", "scm-toolkit.workspace-search-activity-bar", "Standalone Activity Bar", "Move Workspace Search into its own Activity Bar container instead of the Source Control view.", "Search"),
    Setting("workspaceSearchLabel", "scm-toolkit.workspace-search-label", "Search label", "Label for the Workspace Search panel and its standalone Activity Bar container.", "Search", "text"),
    Setting("workspaceSearchPlaceholder", "scm-toolkit.workspace-search-placeholder", "Search box placeholder", "Text shown inside the empty EFS search field, e.g. SATS. Leave blank for the original hint.", "Search", "optional_text"),
    Setting("workspaceSearchEmbeddingModel", "scm-toolkit.workspace-search-embedding-model", "Search embedding model", "Turns workspace passages into searchable meaning. Choose an embedding model, separate from chat models.", "Search", "model"),
    Setting("workspaceSearchAskOllama", "scm-toolkit.workspace-search-ask-ollama", "Ask Ollama", "Show the Ask Ollama action in EFS search results.", "Search"),
    Setting("workspaceSearchChatModel", "scm-toolkit.workspace-search-chat-model", "Ask Ollama chat model", "Ollama chat model used by Ask Ollama. Required when Ask Ollama is enabled.", "Search", "optional_model"),
    Setting("workspaceSearchOllamaUrl", "scm-toolkit.workspace-search-ollama-url", "Search Ollama server", "Loopback URL of the Ollama server used for workspace search.", "Search", "url"),
    Setting("workspaceSearchMode", "scm-toolkit.workspace-search-mode", "Search ranking", "Default ranking mode for search results.", "Search", "select", ("hybrid", "semantic", "exact")),
    Setting("workspaceSearchAutoReindex", "scm-toolkit.workspace-search-auto-reindex", "Automatically refresh search index", "Refresh the workspace search index every two minutes.", "Search"),
    Setting("workspaceSearchResultLimit", "scm-toolkit.workspace-search-result-limit", "Search result limit", "Maximum number of result passages shown.", "Search", "integer", minimum=1, maximum=100),
    Setting("workspaceSearchMaxFiles", "scm-toolkit.workspace-search-max-files", "Search file limit", "Maximum number of workspace files considered for indexing.", "Search", "integer", minimum=1, maximum=50000),
    Setting("workspaceSearchMaxFileSizeMB", "scm-toolkit.workspace-search-max-file-size-mb", "Maximum indexed file size (MB)", "Maximum file size indexed directly.", "Search", "number", minimum=0.1, maximum=100),
    Setting("workspaceSearchExclude", "scm-toolkit.workspace-search-exclude", "Search exclusions", "Glob of paths excluded from workspace indexing. Leave blank to use no exclusions.", "Search", "optional_text"),
    Setting("defaultBranch", "scm-toolkit.default-branch", "Default branch", "Protected branch and pull-request base.", "Initialization", "text"),
    Setting("remote", "scm-toolkit.remote", "Git remote", "Remote used for branch checks and repository discovery.", "Initialization", "text"),
    Setting("branchNameDisabledPacks", "scm-toolkit.branch-name-disabled-packs", "Name packs", "Enable or disable built-in and imported branch-name packs.", "Branch names", "packs"),
    Setting("branchCustomNames", "scm-toolkit.branch-custom-names", "Custom names", "Add your own lowercase branch names, one per line.", "Branch names", "names"),
    Setting("branchNameImports", "scm-toolkit.branch-name-imports", "Imported packs", "Paste third-party packs as JSON using id, label, description, and names.", "Branch names", "imports"),
    Setting("spellcheckManualCommit", "scm-toolkit.spellcheck-preview", "Automatic draft commit spellcheck", "After 1.5 seconds without typing, correct obvious spelling errors in manual commit subjects using local Ollama. Never blocks a commit, replaces the body, or alters Codex-attributed messages. The manual preview action remains available. Off by default.", "Spellcheck Changes"),
    Setting("draftCommitEmoji", "scm-toolkit.draft-commit-emoji", "Add professional emoji to drafted commit titles", "After 1.5 seconds without typing, prefix manual commit subjects with a change-appropriate emoji when they have none. Independent of automatic spelling correction; preserves your emoji, body, and Codex-attributed messages. Uses the built-in title classifier without a second Ollama call. Off by default.", "Spellcheck Changes"),
    Setting("draftSpellcheckAction", "scm-toolkit.draft-spellcheck-action", "Correction handling", "Apply verified corrections automatically, or ask for approval in a before-and-after confirmation after typing stops.", "Spellcheck Changes", "select", ("automatic", "review")),
    Setting("draftSpellcheckDelaySeconds", "scm-toolkit.draft-spellcheck-delay-seconds", "Idle delay (seconds)", "Wait 0.5–10 seconds after typing before checking the current commit subject. Does not delay Commit.", "Spellcheck Changes", "number", minimum=0.5, maximum=10),
    Setting("draftSpellcheckStyle", "scm-toolkit.draft-spellcheck-style", "Correction scope", "Spelling only preserves word and punctuation structure; spelling and grammar also permits small grammatical fixes subject to safety checks.", "Spellcheck Changes", "select", ("spelling", "grammar")),
    Setting("draftSpellcheckVocabulary", "scm-toolkit.draft-spellcheck-vocabulary", "Protected vocabulary", "One term or phrase per line. When present, these exact words, brands or technical expressions must remain unchanged.", "Spellcheck Changes", "textarea"),
    Setting("draftSpellcheckGuidance", "scm-toolkit.draft-spellcheck-guidance", "Additional correction guidance", "Optional preferences or specialist terminology for the local model. Safety checks, protected tokens and user-selected emoji always take precedence.", "Spellcheck Changes", "textarea"),
    Setting("spellcheckModel", "scm-toolkit.spellcheck-model", "Spellcheck model", "Local Ollama model for automatic draft spelling corrections and manual commit previews.", "Spellcheck Changes", "model"),
    Setting("spellcheckThinkingEffort", "scm-toolkit.spellcheck-thinking-effort", "Spellcheck reasoning effort", "Default uses the model's normal behavior. Low, medium, or high requests supported Ollama thinking levels; models offering only an on/off control use thinking on. Unsupported levels fall back to the model default. Applies to commit-subject and Markdown spellchecking; does not change normal commit-title generation.", "Spellcheck Changes", "select", ("default", "low", "medium", "high")),
    Setting("postCommitSpellcheck", "scm-toolkit.post-commit-spellcheck", "Post-commit Markdown spellcheck", "After an automatic commit, propose corrections to changed Markdown prose as unstaged edits for review. Use en dashes for numeric ranges. Off by default.", "Spellcheck Changes"),
    Setting("spellcheckChangesEmoji", "scm-toolkit.spellcheck-changes-emoji", "Add professional emoji to spellcheck commits", "Include the professional leading emoji from normal AI commit-title generation when accepting reviewed Spellcheck Changes. Turn off to omit it without changing title quality, model effort, or attribution. On by default.", "Spellcheck Changes"),
    Setting("spellcheckPreserveLineBreaks", "scm-toolkit.spellcheck-preserve-line-breaks", "Preserve intentional line breaks", "Off by default: prefer joining unnecessarily separated prose and adjacent Markdown links, without flattening distinct paragraphs or Markdown blocks. Turn on to preserve every original line break.", "Spellcheck Changes"),
    Setting("spellcheckInstructions", "scm-toolkit.spellcheck-instructions", "Markdown spellcheck instructions", "Terminology and spelling guidance for post-commit Markdown corrections. Preserve facts, numbers, URLs, and code.", "Spellcheck Changes", "textarea"),
    Setting("aiCommit", "scm-toolkit.ai-commit", "AI commit titles", "Generate commit messages with the selected local AI backend.", "Commits"),
    Setting("aiBackend", "scm-toolkit.ai-backend", "Backend preference order", "Choose one backend or the order to try them. If a backend fails or produces no valid message, try the next before using a simple fallback. Core ML requires its bridge and prepared models; Workspace Search still uses Ollama.", "Commits", "select", ("ollama", "coreml", "coreml,ollama", "ollama,coreml")),
    Setting("aiCoremlModel", "scm-toolkit.ai-coreml-model", "Core ML model", "Registered CoreML-LLM model ID. Default qwen3.5-2b; run sweetiebot-ane --prepare MODEL to download and compile it before use.", "Commits", "text"),
    Setting("aiCoremlLowMemoryModel", "scm-toolkit.ai-coreml-low-memory-model", "Core ML low-memory model", "Registered smaller CoreML-LLM model ID, used when available RAM falls below your threshold.", "Commits", "text"),
    Setting("aiCoremlCommand", "scm-toolkit.ai-coreml-command", "Core ML bridge executable", "Absolute path to your locally built sweetiebot-ane bridge. Install instructions in native/coreml-llm-bridge/README.md.", "Commits", "text"),
    Setting("durableBackgroundCommits", "scm-toolkit.durable-background-commits", "Durable background Commit and Push", "Commit staged changes locally at once with a placeholder, then apply the generated message and optionally push in the background. Includes offline retries and restart recovery. Off by default.", "Source control"),
    Setting("autoCommitWithCodex", "scm-toolkit.auto-commit-with-codex", "Auto-commit with Codex every 30 seconds", "Opt in to check saved Git changes every 30 seconds and create a local commit co-authored by Codex. Automatically stages modified, deleted and untracked files. Skips clean repositories, merge conflicts and commits with drafted messages. Never pushes automatically.", "Source control"),
    Setting("aiDetailedCommitStyle", "scm-toolkit.ai-detailed-commit-style", "Detailed AI commit descriptions on all branches", "Opt in to generated explanatory commit bodies on topic branches as well as main. Your configured instructions, emoji priorities, and co-author settings apply in both fast and durable modes.", "Commits"),
    Setting("aiTitleExplanations", "scm-toolkit.ai-title-explanations", "Explain AI commit title choices", "Optional: ask the same Ollama generation request for a short explanation of the title wording. Diagnostics shows a collapsible Why this title? note. Explanations are stored locally in diagnostics logs and JSON exports, never in the Git commit. Off by default for speed and privacy.", "Commits"),
    Setting("aiCommitFallback", "scm-toolkit.ai-commit-fallback", "Fall back to simple commit messages", "After failed attempts or when the generation time budget expires, use a simple staged-file message instead of blocking the commit. Missing models fall back immediately. Disable for strict AI-only debugging.", "Commits"),
    Setting("aiCommitRequestTimeoutSeconds", "scm-toolkit.ai-commit-request-timeout-seconds", "Commit request timeout (seconds)", "Maximum wait for one model request. Choose 1–900 seconds. The overall generation budget is this timeout multiplied by the attempt count.", "Commits", "integer", minimum=1, maximum=900),
    Setting("aiCommitAttempts", "scm-toolkit.ai-commit-attempts", "Attempts per model step", "Maximum attempts for each emoji check or title-generation step. Choose 1–10. All steps and retries share the calculated overall budget; changes apply to new jobs immediately.", "Commits", "integer", minimum=1, maximum=10),
    Setting("aiDefaultBranchDescription", "scm-toolkit.ai-default-branch-description", "Default-branch descriptions", "Add a short description when generating commits on the default branch.", "Commits"),
    Setting("aiEmojiPriorityRules", "scm-toolkit.ai-emoji-priority-rules", "Enforce custom emoji priorities", "Check your custom emoji priority list in order and enforce the first matching rule. Requires a priority list in your commit instructions and can increase generation time. On by default.", "Commits"),
    Setting("aiModelPicker", "scm-toolkit.ai-model-picker", "Model picker command", "Install the separate model-selection helper.", "Commits"),
    Setting("aiCommitModel", "scm-toolkit.ai-commit-model", "Normal model", "Ollama model used when memory is available.", "Commits", "model"),
    Setting("aiCommitLowMemoryModel", "scm-toolkit.ai-commit-low-memory-model", "Low-memory model", "Smaller Ollama model used below the memory threshold.", "Commits", "model"),
    Setting("aiLowMemoryGiB", "scm-toolkit.ai-low-memory-gib", "Low-memory threshold (GiB)", "Available-memory threshold for selecting the smaller model.", "Commits", "number"),
    Setting("squashOmitBulletsForEmojiTitles", "scm-toolkit.squash-omit-bullets-for-emoji-titles", "Omit hyphens when every commit title starts with an emoji", "Remove the leading hyphens only when every included commit title begins with an emoji. Mixed titles keep their bullets. Off by default.", "Pull requests"),
    Setting("squashTrailerSeparatorStyle", "scm-toolkit.squash-trailer-separator-style", "Squash co-author separator", "Divider between squash summaries and Co-authored-by trailers: Hyphens (---------), Underscores (__________), or None. Underscores remain the default.", "Pull requests", "select", ("underscores", "hyphens", "none")),
    Setting("filterSyncCommitSummaries", "scm-toolkit.filter-sync-commit-summaries", "Exclude sync commits from squash summaries", "Hide routine Sync brach/branch to main commits and their descriptions in generated PR squash summaries, while preserving all author and co-author credits. On by default.", "Pull requests"),
    Setting("mcpPullRequest", "scm-toolkit.mcp-pull-request", "Pull-request button", "Draft in ChatGPT and publish with codex-pony. The GitHub app must have access to this repository; click the button for setup help when access is missing.", "Pull requests"),
    Setting("prWarningHighlights", "scm-toolkit.pr-warning-highlights", "Highlight PR eligibility warnings", "Opt in to a colored PR button when its eligibility or setup check fails. Off keeps the icon muted gray while retaining validation and diagnostic tooltips.", "Pull requests"),
    Setting("mergeAutoRefresh", "scm-toolkit.merge-auto-refresh", "Refresh active merge dashboard", "Refresh GitHub status only while the merge dashboard is visible and its window is focused. Local merge work continues in the background.", "GitHub"),
    Setting("mergeRefreshIntervalSeconds", "scm-toolkit.merge-refresh-interval-seconds", "Merge refresh interval (seconds)", "Delay between GitHub status updates in an active merge dashboard. Choose 30–3600 seconds.", "GitHub", "integer", minimum=30, maximum=3600),
    Setting("githubRateLimitCooldownSeconds", "scm-toolkit.github-rate-limit-cooldown-seconds", "GitHub rate-limit fallback (seconds)", "Pause when GitHub does not supply a reset time. Choose 60–3600 seconds. Server reset times always take precedence.", "GitHub", "integer", minimum=60, maximum=3600),
    Setting("mergePostSummaries", "scm-toolkit.merge-post-summaries", "Post AI merge summaries to GitHub", "Opt in to a concise summary on each selected PR after its merge is verified. Local explanations always remain available. Off by default.", "Lindsey"),
    Setting("mergeShowPrCommits", "scm-toolkit.merge-show-pr-commits", "Show PR commits in bulk merge", "Display the selected PR’s commit-history graph in Lindsey’s bulk-merge details. Hide it to give the diff the full width without changing merge behavior. On by default.", "Lindsey"),
    Setting("mergeTimelineTimestampMode", "scm-toolkit.merge-timeline-timestamp-mode", "Activity timeline timestamps", "Choose hidden, relative elapsed time, or local clock time in Lindsey’s activity timeline.", "Lindsey", "select", ("hidden", "relative", "clock")),
    Setting("mergeSidebarWidthPercent", "scm-toolkit.merge-sidebar-width-percent", "PR list width (%)", "Starting share of the dashboard for the PR list. Drag the vertical divider to adjust it while reviewing.", "Lindsey", "integer", minimum=15, maximum=75),
    Setting("mergeTimelineHeightPercent", "scm-toolkit.merge-timeline-height-percent", "Activity timeline height (%)", "Starting share of the left pane below its heading. Drag the timeline’s top divider to adjust it while reviewing.", "Lindsey", "integer", minimum=15, maximum=80),
    Setting("kefaniaUseThemeColors", "scm-toolkit.kefania-use-theme-colors", "Use VS Code theme colors", "Use the current theme for Kefania buttons, close icons, image controls, and page colors.", "Kefania"),
    Setting("kefaniaCloseAfterMerge", "scm-toolkit.kefania-close-after-merge", "Close Kefania after squash and merge", "Close the Kefania confirmation window after GitHub confirms a successful squash and merge.", "Kefania"),
    Setting("kefaniaShowCloseButton", "scm-toolkit.kefania-show-close-button", "Show Kefania X button", "Show the close-window X after publishing a PR in Kefania.", "Kefania"),
    Setting("kefaniaCloseButtonPosition", "scm-toolkit.kefania-close-button-position", "Kefania X button", "Hide the close-window X or place it on the left, middle (above the pony card), or right after publishing a PR.", "Kefania", "select", ("hidden", "left", "middle", "right")),
    Setting("autoPublishPullRequests", "scm-toolkit.auto-publish-pull-requests", "Automatically publish PR drafts", "Publish a completed Kefania PR draft automatically, without clicking the confirmation button. Pony research runs independently.", "Pull requests"),
    Setting("ludicrousMode", "scm-toolkit.ludicrous-mode", "Ludicrous mode", "Skip the confirmation box when you click Squash and merge in the Kefania dialog.", "Pull requests"),
    Setting("mcpPrServer", "scm-toolkit.mcp-pr-server", "Pull-request MCP server", "VS Code MCP server checked before New PR opens. Connect the same server separately in ChatGPT; local servers can use Secure MCP Tunnel.", "Pull requests", "text"),
    Setting("mcpPrTool", "scm-toolkit.mcp-pr-tool", "Pull-request MCP tool", "Configured MCP tool name for pull-request integrations.", "Pull requests", "text"),
    Setting("codexUsageResetCountdown", "scm-toolkit.codex-usage-reset-countdown", "Relative Codex reset times", "Convert Codex's absolute reset dates and times into live relative countdowns in usage-limit banners (for example, 'resets October 24 at 3 PM' becomes 'resets in 1d 4h').", "Codex"),
    Setting("codexRateLimitSticker", "scm-toolkit.codex-rate-limit-sticker", "Rate-limit sticker", "Show a compact rate-limit image card; customize the image below or keep the bundled Twilight artwork. Independent of the countdown and reset-time settings.", "Codex"),
    Setting("codexHideUsageResetTimes", "scm-toolkit.codex-hide-usage-reset-times", "Hide Codex reset times", "Hide reset dates and times in Codex usage menus, dialogs, limit banners, transcript messages, and tooltips, even when the countdown is disabled.", "Codex"),
    Setting("codexUsagePieIndicator", "scm-toolkit.codex-usage-pie-indicator", "Five-hour pie and weekly usage bar", "Replace the composer’s + icon with the five-hour remaining-usage pie while retaining the attachment menu. Show the weekly remaining allowance as a thin bar along the bottom of the input.", "Codex"),
    Setting("codexCloudTasks", "scm-toolkit.codex-cloud-tasks", "Enable cloud tasks", "Allow Codex’s cloud execution selector. Off by default: tasks stay local and the native location/usage menu is hidden. Apply through app repair, then reload the intended window.", "Codex"),
    Setting("codexResetTimePieIndicator", "scm-toolkit.codex-reset-time-pie-indicator", "Reset countdown pie indicators", "Show a time-remaining pie beside each five-hour and weekly Codex usage-menu reset countdown. Pies empty as the reset approaches; hiding reset times overrides this setting. Off by default.", "Codex"),
    Setting("codexHidePromotions", "scm-toolkit.codex-hide-promotions", "Hide Codex promotions", "Hide promotional panels in Codex.", "Codex"),
    Setting("codexShortModelLabels", "scm-toolkit.codex-short-model-labels", "Short model labels", "Shorten the active model display: remove GPT, use Med for Medium, Low for Light, and Uber for Extra high.", "Codex"),
    Setting("codexHidePermissionsIcon", "scm-toolkit.codex-hide-permissions-icon", "Hide permissions icon", "Choose permissions from Change permissions below instead of the Codex composer icon.", "Codex"),
    Setting("codexComposerLayout", "scm-toolkit.codex-composer-layout", "Composer layout", "Reorder and hide Codex composer controls with a fallback menu.", "Codex", "codex_layout"),
    Setting("codexFlatComposer", "scm-toolkit.codex-flat-composer", "Flat prompt box", "Use a compact prompt surface with subtle corners, no shadow, and a theme-colored focus border.", "Codex"),
    Setting("codexHideAccessLabel", "scm-toolkit.codex-hide-access-label", "Hide access label", "Show only the icon for the Codex access control, hiding labels such as Full access.", "Codex"),
    Setting("codexShowQueuedDelete", "scm-toolkit.codex-show-queued-delete", "Show queued-message Delete button", "Show the trash button beside queued Codex messages. Turn off to hide it; inline editing and Steer remain available. Apply through app repair, then reload the Codex view.", "Codex"),
    Setting("codexShowQueuePause", "scm-toolkit.codex-show-queue-pause", "Show Pause queue button", "Show Pause queue / Resume queue above queued Codex messages. Pauses automatic queued sends while allowing the current response to finish. Apply through app repair, then reload the Codex view.", "Codex"),
    Setting("codexInlineQueuedEditing", "scm-toolkit.codex-inline-queued-editing", "Edit queued messages inline", "Click queued message text to edit it in place. Automatic turns wait until you save, cancel, or leave the editor.", "Codex"),
    Setting("codexInlineLocation", "scm-toolkit.codex-inline-location", "Computer and usage beside access", "Move the native computer and usage control beside the access icon.", "Codex"),
    Setting("codexClipboardSubmit", "scm-toolkit.codex-clipboard-submit", "Clipboard Send / Queue button", "Send clipboard text when idle and no messages are waiting; otherwise join the native FIFO queue without interrupting the current task.", "Codex"),
    Setting("codexInterruptOnSendClick", "scm-toolkit.codex-interrupt-on-send-click", "Click Send to interrupt Codex", "When Codex is working, clicking its native Send or Queue control stops the current response and sends the typed message once native Send becomes available. Enter keeps native queue behavior; the clipboard button never interrupts. Turn off to retain native clicks.", "Codex"),
    Setting("codexSendWing", "scm-toolkit.codex-send-wing", "Pegasus wing Send/Stop icons", "Replace the native Send arrow with a white-outline wing and the Stop square with a mirrored wing. Follows theme and Send icon color settings; Queue stays native.", "Codex"),
    Setting("codexSendBackground", "scm-toolkit.codex-send-background", "Send button background", "Hex color for the Codex send button. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexNewChatDotColor", "scm-toolkit.codex-new-chat-dot-color", "New Chat notification dot", "Hex color for the unread dot on the Codex New Chat icon. Leave blank to follow the Send button background, or the theme if that is unset.", "Codex", "color"),
    Setting("codexSendForeground", "scm-toolkit.codex-send-foreground", "Send button icon", "Hex color for the Codex send icon or pegasus-wing outline. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexComposerLabelColor", "scm-toolkit.codex-composer-label-color", "Composer control color", "Hex color for Full access, Work locally, and the + add-context control. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexDropAccent", "scm-toolkit.codex-drop-accent", "Image drop accent", "Hex color for the drop highlight, border, and attachment prompt. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexHideDictation", "scm-toolkit.codex-hide-dictation", "Hide dictation button", "Hide the microphone dictation control in Codex chat.", "Codex"),
    Setting("codexHideChatTimestamps", "scm-toolkit.codex-hide-chat-timestamps", "Hide chat timestamps", "Hide standalone date/time separators inside Codex conversations.", "Codex"),
    Setting("codexShowCannon", "scm-toolkit.codex-show-cannon", "Show cannon", "Replace active and completed work-duration labels with the Flawless cannon and one dot per elapsed minute. Native activity controls remain available.", "Codex"),
    Setting("codexNewChatPlaceholder", "scm-toolkit.codex-new-chat-placeholder", "New chat input text", "Replace ‘Do anything’ in a new Codex chat. Leave blank to use the original text. Apply through app repair, then reload VS Code.", "Codex", "optional_text"),
    Setting("codexFollowUpPlaceholder", "scm-toolkit.codex-follow-up-placeholder", "Follow-up input text", "Replace ‘Ask for follow-up changes’ in a local Codex chat. Leave blank to use the original text. Apply through app repair, then reload VS Code.", "Codex", "optional_text"),
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
    if settings.get("aiCommit") and settings.get("aiBackend", "ollama") == "ollama":
        required.extend(["aiCommitModel", "aiCommitLowMemoryModel"])
    if settings.get("spellcheckManualCommit"):
        required.append("spellcheckModel")
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
        if setting.name == "kefaniaShowCloseButton":
            # The position dropdown supplies this legacy runtime preference.
            continue
        if setting.kind in {"packs", "names", "imports"}:
            continue
        if setting.kind == "codex_layout":
            parsed[setting.name] = serialize_codex_layout(values.get(setting.name, [""])[0])
            continue
        if setting.kind == "message_bar":
            parsed[setting.name] = serialize_message_bar_layout(
                values.get(setting.name, [""])[0]
            )
            continue
        if setting.kind == "push_checkbox":
            parsed[setting.name] = "push" if values.get(setting.name, ["none"])[0] == "push" else "none"
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
            limit = 5000 if setting.name == "draftSpellcheckVocabulary" else (
                2000 if setting.name == "draftSpellcheckGuidance" else None
            )
            if limit is not None and len(raw_value) > limit:
                raise ValueError(f"{setting.label} must be at most {limit} characters.")
            if setting.name == "draftSpellcheckVocabulary" and len(raw_value.splitlines()) > 100:
                raise ValueError("Protected vocabulary supports at most 100 lines.")
            parsed[setting.name] = raw_value.strip()
            continue

        value = raw_value.strip()
        if setting.kind == "chatgpt_project_url":
            if value:
                url = urllib.parse.urlsplit(value)
                if (url.scheme != "https" or url.netloc != "chatgpt.com" or
                        url.query or url.fragment or
                        not re.fullmatch(r"/g/g-p-[A-Za-z0-9-]+/project/?", url.path)):
                    raise ValueError(f"{setting.label} must be a ChatGPT project link like https://chatgpt.com/g/g-p-.../project.")
                value = f"https://chatgpt.com{url.path.rstrip('/')}"
            parsed[setting.name] = value
            continue
        if setting.kind == "browser_url":
            value = value or "https://chatgpt.com/"
            if any(char in value for char in ("\x00", "\n", "\r")) or not urllib.parse.urlparse(value).scheme:
                raise ValueError(f"{setting.label} must be a complete URL, such as https://chatgpt.com/.")
            parsed[setting.name] = value
            continue
        if setting.kind == "optional_model":
            if "\x00" in value or "\n" in value or "\r" in value:
                raise ValueError(f"{setting.label} must fit on one line.")
            parsed[setting.name] = value
            continue
        if setting.kind == "select":
            if value not in setting.choices:
                raise ValueError(f"Choose a valid {setting.label.lower()}.")
            if setting.name == "kefaniaCloseButtonPosition":
                parsed["kefaniaShowCloseButton"] = value != "hidden"
                parsed[setting.name] = "left" if value == "hidden" else value
                continue
            parsed[setting.name] = value
            continue
        if setting.kind == "coauthor_name":
            if not value or len(value) > 100 or any(
                ord(char) < 32 or ord(char) == 127 or char in "<>\u2028\u2029"
                for char in value
            ):
                raise ValueError("Commit co-author name must be a single line (1–100 characters) without angle brackets.")
            parsed[setting.name] = value
            continue
        if setting.kind == "coauthor_email":
            if len(value) > 254 or not re.fullmatch(r"[^\s<>@]+@[^\s<>@]+", value):
                raise ValueError("Commit co-author email must be a single valid name@domain address.")
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
    layout = parse_message_bar_layout(parsed["messageBarLayout"])
    active = set(layout["before"] + layout["after"])
    for name, item in MESSAGE_BAR_VISIBILITY_SETTINGS.items():
        parsed[name] = item in active
    if not parsed["commitAndPush"]:
        parsed["postCommitAction"] = "none"
    # The branch machinery also supplies Sync and Home when the picker is hidden.
    parsed["branchPicker"] = bool(active & {"branch", "sync", "home"})
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
            cwd=Path.home(),
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
                cwd=Path.home(),
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
            subprocess.run(args, capture_output=True, text=True, cwd=Path.home())
        raise


def _pack_controls(current: dict[str, object]) -> str:
    disabled = set(parse_pack_id_list(current.get("branchNameDisabledPacks", "")))
    raw_imports = current.get("branchNameImports", "[]")
    try:
        imports = parse_imported_packs(raw_imports)
        catalog = merge_catalog(load_catalog(), imports)
    except ValueError:
        catalog = load_catalog()

    hidden_inputs = []
    tabs = []
    panels = []
    for index, pack in enumerate(catalog["packs"]):
        pack_id = str(pack["id"])
        label = str(pack["label"])
        description = str(pack.get("description", "")).strip()
        names = [str(name) for name in pack["names"]]
        count = len(names)
        checked = "" if pack_id in disabled else " checked"
        escaped_id = html.escape(pack_id, quote=True)
        selected = "true" if index == 0 else "false"
        tab_index = "0" if index == 0 else "-1"
        hidden = "" if index == 0 else " hidden"
        description_html = html.escape(description or "No description provided.")
        names_html = "".join(
            f'<code class="pack-name">{html.escape(name)}</code>'
            for name in names
        )
        hidden_inputs.append(
            f'<input type="hidden" name="branchNameKnownPack" value="{escaped_id}">'
        )
        tabs.append(
            f'<button type="button" class="pack-tab" role="tab" '
            f'id="pack-tab-{escaped_id}" data-pack-id="{escaped_id}" '
            f'aria-controls="pack-panel-{escaped_id}" aria-selected="{selected}" '
            f'tabindex="{tab_index}"><strong>{html.escape(label)}</strong>'
            f'<small>{count}</small></button>'
        )
        panels.append(
            f'<section class="pack-panel" role="tabpanel" id="pack-panel-{escaped_id}" '
            f'data-pack-id="{escaped_id}" aria-labelledby="pack-tab-{escaped_id}"{hidden}>'
            '<div class="pack-panel-head"><span>'
            f'<strong>{html.escape(label)}</strong><small>{description_html}</small></span>'
            '<label class="pack-enable">'
            f'<input type="checkbox" name="branchNamePack" value="{escaped_id}"{checked}>'
            '<span>Use this bundle</span></label></div>'
            f'<div class="pack-name-heading"><span>{count} name{"s" if count != 1 else ""}</span>'
            '<small>These are the branch names this bundle can generate.</small></div>'
            f'<div class="pack-names">{names_html}</div></section>'
        )
    return (
        '<fieldset class="pack-picker"><legend>Name bundles</legend>'
        '<p>Browse each bundle before deciding whether it belongs in the random branch-name pool.</p>'
        '<div class="pack-toolbar"><input type="search" id="pack-search" '
        'aria-label="Find name bundles or names" placeholder="Find a bundle or name…">'
        '<output id="pack-count" aria-live="polite"></output></div>'
        + "".join(hidden_inputs)
        + '<div class="pack-tabs" role="tablist" aria-label="Branch name bundles">'
        + "".join(tabs) + '</div>'
        + '<div class="pack-panels">' + "".join(panels) + '</div>'
        + '<p id="pack-empty" hidden>No bundles or names match that search.</p></fieldset>'
    )


def _setting_control(setting: Setting, current: object) -> str:
    if setting.name == "codexHidePermissionsIcon":
        # Retain a disabled field for settings inventory; it is omitted from FormData.
        # Visibility is now controlled by the Codex composer layout instead.
        return '<input type="hidden" name="codexHidePermissionsIcon" value="true" disabled>'
    if setting.name == "kefaniaShowCloseButton":
        return ""
    if setting.name in MESSAGE_BAR_VISIBILITY_SETTINGS or setting.name == "inlineSuggestions":
        disabled = "" if current is True else " disabled"
        return f'<input type="hidden" name="{html.escape(setting.name, quote=True)}" value="true"{disabled}>'
    if setting.name in {"messagePlaceholder", "postCommitAction", "postCommitSpellcheck", "commitButtonLabel", "commitAndSendButtonLabel", "windowHeading"}:
        return ""
    if setting.kind == "codex_layout":
        return ""
    if setting.kind == "message_bar":
        return render_message_bar_control(current)

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
        backend_labels = {"ollama": "Ollama only", "coreml": "Core ML only",
                          "coreml,ollama": "Core ML → Ollama", "ollama,coreml": "Ollama → Core ML"}
        options = "".join(
            f'<option value="{html.escape(choice, quote=True)}"'
            + (' selected' if choice == str(current) else '')
            + f'>{html.escape(backend_labels[choice] if setting.name == "aiBackend" else choice.capitalize() if choice else "None")}</option>'
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
        required = (' placeholder="VS Code default"'
                    if setting.name in {"windowHeading", "windowName"} else "")
    elif setting.kind == "chatgpt_project_url":
        required = ' placeholder="https://chatgpt.com/g/g-p-.../project"'
    elif setting.kind == "browser_url":
        required = ' placeholder="https://chatgpt.com/"'
    elif setting.kind == "optional_model":
        required = ' placeholder="Choose a chat model"'
    else:
        required = " required"
    if setting.kind in {"model", "optional_model"}:
        return (
            '<div class="setting field-row model-row">'
            f'<span><label for="{name}"><strong>{label}</strong></label><small>{description}</small>'
            f'<small class="model-status" data-model="{name}" role="status"></small></span>'
            f'<div class="model-picker" data-model-picker="{name}">'
            f'<input id="{name}"{attrs} name="{name}" value="{value}"{required} autocomplete="off" '
            f'role="combobox" aria-autocomplete="list" aria-expanded="false" '
            f'aria-controls="{name}-options">'
            f'<button type="button" class="model-picker-toggle" data-model="{name}" '
            f'aria-label="Choose {label}" aria-expanded="false">▾</button>'
            f'<div id="{name}-options" class="model-options" role="listbox" hidden></div></div>'
            f'<button type="button" class="download-model" data-model="{name}">Download</button></div>'
        )
    input_class = ' class="compact-number"' if setting.name == "aiLowMemoryGiB" else ""
    budget_output = ('<small><output id="commit-generation-budget" aria-live="polite"></output></small>'
                     if setting.name == 'aiCommitAttempts' else '')
    return (
        '<label class="setting field-row">'
        f'<span><strong>{label}</strong><small>{description}</small>{budget_output}</span>'
        f'<input{attrs}{input_class} name="{name}" value="{value}"{list_attr}{required}></label>'
    )



def _local_setup_controls() -> str:
    instructions = html.escape(load_commit_instructions())
    status = signing_status()
    configured = str(status.get("configured") or "").upper()
    keys = list(status.get("keys") or [])
    options = []
    for key in keys:
        fingerprint = str(key.get("fingerprint") or "").upper()
        if not fingerprint:
            continue
        uid = str(key.get("uid") or "").strip()
        label = uid or fingerprint
        if uid:
            label += f" · {fingerprint[-16:]}"
        selected = " selected" if fingerprint == configured else ""
        options.append(
            f'<option value="{html.escape(fingerprint, quote=True)}"{selected}>'
            f'{html.escape(label)}</option>'
        )
    if not options:
        empty_label = (
            "No local OpenPGP signing keys found"
            if status.get("gpgAvailable")
            else "Cannot list OpenPGP keys: GnuPG unavailable"
        )
        options.append(f'<option value="">{empty_label}</option>')

    signing_format = str(status.get("format") or "openpgp")
    if not status.get("enabled"):
        configured_label = "Git commit signing is disabled."
        if configured:
            configured_label += f" A signing key is configured: {configured[-16:]}."
    elif configured:
        configured_label = f"Git commit signing is enabled with {configured[-16:]} ({signing_format})."
        if signing_format == "openpgp" and status.get("gpgAvailable") and not any(
            str(key.get("fingerprint") or "").upper().endswith(configured.removeprefix("0X").rstrip("!"))
            for key in keys
        ):
            configured_label += " The configured key was not found among local OpenPGP keys."
    else:
        configured_label = "Git commit signing is enabled, but no signing key is explicitly configured."
    if not status.get("gpgAvailable"):
        configured_label += " GnuPG is unavailable; local OpenPGP keys could not be checked."

    key_disabled = "" if keys else " disabled"
    generate_disabled = "" if status.get("gpgAvailable") else " disabled"
    instructions_path = html.escape(str(status.get("instructionsPath") or ""), quote=True)
    return (
        '<label class="setting textarea-row"><span><strong>Sweetiebot commit instructions</strong>'
        f'<small>Edit the standalone local instruction file at <code>{instructions_path}</code>. '
        'Sweetiebot reads this file directly; it is not synchronized with ChatGPT or another agent.</small></span>'
        f'<textarea name="commitInstructions" rows="8" spellcheck="false">{instructions}</textarea></label>'
        '<div class="setting field-row"><span><strong>Git signing key</strong>'
        '<small>Private key material stays in your local OpenPGP key store and secure pinentry/key manager. '
        'Sweetiebot only reads public fingerprints and tells Git which local key to use.</small>'
        f'<small id="signing-key-status">{html.escape(configured_label)}</small></span>'
        '<div class="signing-actions">'
        f'<select id="signing-key" aria-label="Local OpenPGP signing key"{key_disabled}>{"".join(options)}</select>'
        f'<button type="button" id="use-signing-key"{key_disabled}>Use key</button>'
        f'<button type="button" id="generate-signing-key"{generate_disabled}>Create key</button>'
        '<button type="button" id="open-signing-key-manager">Open key manager</button>'
        '</div></div>'
    )

def render_form(
    current: dict[str, object],
    models: list[str],
    ollama_status: str,
    token: str,
    action_label: str,
    error: str = "",
    *,
    finish_on_save: bool = True,
    server_instance: str = "",
    commit_hotkey: str | None = None,
    codex_commit_hotkey: str | None = None,
) -> str:
    current = dict(current)
    if current.get("kefaniaShowCloseButton") is False:
        current["kefaniaCloseButtonPosition"] = "hidden"
    sections = []
    tabs = []
    section_names = list(dict.fromkeys(setting.section for setting in SETTINGS))
    section_names.remove("GitHub")
    section_names.insert(section_names.index("Codex"), "GitHub")
    section_names.insert(section_names.index("GitHub") + 1, "GitHub Apps")
    section_names.append("Diagnostics")
    for index, section in enumerate(section_names):
        controls = "".join(
            _setting_control(setting, current.get(setting.name, ""))
            for setting in SETTINGS
            if setting.section == section
        )
        if section == "Diagnostics":
            controls = DIAGNOSTICS_PANEL
        if section == "GitHub Apps":
            controls = APP_PANEL
        if section == "Codex":
            time_settings = {
                "codexKeepAwake", "codexUsageResetCountdown", "codexHideUsageResetTimes",
                "codexUsagePieIndicator", "codexResetTimePieIndicator", "codexHideChatTimestamps", "codexShowCannon",
            }
            controls = "".join(
                f'<div class="settings-group"><h3>{heading}</h3>'
                + "".join(
                    _setting_control(setting, current.get(setting.name, ""))
                    for setting in SETTINGS
                    if setting.section == section and (setting.name in time_settings) == is_time
                )
                + '</div>'
                for heading, is_time in (("Time", True), ("Customization", False))
            )
        if section == "Codex":
            controls = render_codex_layout_control(current.get("codexComposerLayout", "")) + controls
            controls += '<div class="setting"><span><strong>Codex permissions</strong><small>Use Codex’s permissions menu, including its access confirmations.</small></span><button type="button" id="codex-permissions">Change permissions…</button><span id="codex-permissions-status" role="status"></span></div>'
            image_status = ("Custom image cached on this computer" if codex_sticker.sticker_path().is_file()
                            else "Bundled Twilight image")
            controls += (
                '<div class="setting sticker-setting"><span><strong>Rate-limit sticker image</strong>'
                '<small>PNG, JPEG, GIF or WebP up to 2 MB. Stored in your private local app data, '
                'not in Git, settings sync or a remote URL. Rebuild/reload Codex after changing.</small></span>'
                '<div class="sticker-actions"><input type="file" id="sticker-upload" '
                'accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp" '
                'aria-label="Choose rate-limit sticker artwork">'
                '<button type="button" id="sticker-reset">Use bundled image</button>'
                f'<output id="sticker-status" role="status" aria-live="polite">{html.escape(image_status)}</output>'
                '</div></div>'
            )
        if section == "Window":
            controls = render_heading(current.get("windowHeading", "")) + controls
        if section == "Message bar":
            layout_setting = next(setting for setting in SETTINGS if setting.kind == "message_bar")
            controls = render_message_bar_control(
                current.get(layout_setting.name, ""), current.get("messagePlaceholder", ""),
                current.get("postCommitAction", "none"),
                current.get("commitButtonLabel", "Commit"), current.get("commitAndSendButtonLabel", "Commit and push"),
                post_spellcheck=current.get("postCommitSpellcheck", False),
            )
            controls += "".join(
                _setting_control(setting, current.get(setting.name, ""))
                for setting in SETTINGS
                if setting.section == section and setting.kind != "message_bar"
            )
        if section == "Message bar":
            controls += _commit_hotkey_control(commit_hotkey)
            controls += _commit_hotkey_control(
                codex_commit_hotkey,
                prefix="codex-commit-hotkey",
                label="Commit with Codex co-author hotkey",
                description=("Run the same action as the Codex co-author commit button, "
                             "including its configured trailer and commit flow. "
                             "Independently configurable and unbound by default."),
            )
        if section == "Branch names":
            controls = _pack_controls(current) + controls
        if section == "Source control":
            controls += (
                '<div class="setting"><span><strong>Commit hotkeys</strong>'
                '<small>Configure the normal Commit and Commit with Codex co-author '
                'shortcuts independently in the Message bar tab. Both start unbound.</small>'
                '</span></div>'
            )
            controls += _local_setup_controls()
        if section == "Pull requests":
            squash_formatting = {"squashOmitBulletsForEmojiTitles", "filterSyncCommitSummaries", "squashTrailerSeparatorStyle"}
            controls = (
                '<div class="settings-group"><h3>Squash formatting</h3>'
                + "".join(_setting_control(setting, current.get(setting.name, ""))
                          for setting in SETTINGS if setting.name in squash_formatting)
                + '</div><div class="settings-group"><h3>Pull requests</h3>'
                + "".join(_setting_control(setting, current.get(setting.name, ""))
                          for setting in SETTINGS if setting.section == section
                          and setting.name not in squash_formatting)
                + '</div>'
            )
            controls = (
                '<div class="setting"><span><strong>Codex Pony repository access</strong>'
                '<small>New PR requires Codex Pony to be installed on the repository owner’s account or organization, '
                'with this repository included in its access. Installing it on another account does not grant access here. '
                '<a href="https://github.com/settings/apps/codex-pony/installations" target="_blank" rel="noopener noreferrer">'
                'Manage app access</a>. After setup, click New PR and choose Retry to refresh the access check.</small></span></div>'
            ) + controls
        status = ""
        if section in {"Commits", "Search", "Spellcheck Changes"}:
            status = f'<p class="status">{html.escape(ollama_status)}</p>'
        if section == "Spellcheck Changes":
            draft_controls = {"spellcheckManualCommit", "draftSpellcheckAction",
                              "draftSpellcheckDelaySeconds", "draftSpellcheckStyle",
                              "draftSpellcheckVocabulary", "draftSpellcheckGuidance",
                              "draftCommitEmoji", "spellcheckModel",
                              "spellcheckThinkingEffort"}
            controls = (
                '<div class="settings-group"><h3>While drafting a commit</h3>'
                + "".join(_setting_control(setting, current.get(setting.name, ""))
                          for setting in SETTINGS if setting.section == section
                          and setting.name in draft_controls)
                + '</div><div class="settings-group"><h3>After committing</h3>'
                + "".join(_setting_control(setting, current.get(setting.name, ""))
                          for setting in SETTINGS if setting.section == section
                          and setting.name not in draft_controls)
                + '<div class="setting"><span><strong>Opt out in one repository</strong>'
                  '<small>Keep the global Spellcheck toggle on, but stop automatic post-commit '
                  'Markdown corrections in a particular repository. In that repository, add '
                  '<code>&quot;scmToolkit.postCommitSpellcheck&quot;: false</code> to '
                  '<code>.vscode/settings.json</code>. Other repositories still spellcheck. '
                  'Remove the entry or set it to <code>true</code> to restore spellcheck there. '
                  'Draft commit checks and manual Spellcheck Only remain available.</small>'
                  '</span></div></div>'
            )
        tab_id = f"settings-tab-{index}"
        panel_id = f"settings-panel-{index}"
        selected = "true" if index == 0 else "false"
        tabindex = "0" if index == 0 else "-1"
        hidden = "" if index == 0 else " hidden"
        tabs.append(
            f'<button class="settings-tab" type="button" role="tab" id="{tab_id}" '
            f'aria-controls="{panel_id}" aria-selected="{selected}" tabindex="{tabindex}">'
            f'{html.escape(section)}</button>'
        )
        sections.append(
            f'<section class="settings-panel" id="{panel_id}" role="tabpanel" '
            f'aria-labelledby="{tab_id}"{hidden}><h2>{html.escape(section)}</h2>{status}{controls}</section>'
        )

    error_html = f'<div class="error" role="alert">{html.escape(error)}</div>' if error else ""
    action = "/save?token=" + urllib.parse.quote(token)
    models_json = json.dumps(models).replace("<", "\\u003c")
    instance_json = json.dumps(server_instance).replace("<", "\\u003c")
    submit_label = action_label
    submit_hidden = "" if finish_on_save else " hidden"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sweetiebot SCM Setup</title><style>
:root{{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#f0f6fc;--muted:#8b949e;--accent:#2f81f7;--danger:#f85149}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{width:min(1120px,calc(100% - 32px));margin:40px auto 96px}}header{{margin-bottom:24px}}.settings-header{{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}}.settings-header>div:first-child{{min-width:0}}.rebuild-actions{{display:flex;flex-direction:column;align-items:flex-end;gap:7px;min-width:160px}}.rebuild-actions output{{font-size:12px;max-width:290px;text-align:right;color:var(--muted)}}.rebuild-actions output.error-state{{color:#ffb3ad}}h1{{margin:0 0 8px;font-size:30px}}header p,.status{{color:var(--muted)}}
.settings-panel{{margin:0;padding:8px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}}.settings-panel[hidden]{{display:none}}h2{{font-size:16px;margin:10px 0}}
.settings-group h3{{font-size:14px;margin:14px 0 4px;color:var(--muted)}}.settings-group+.settings-group{{margin-top:18px;padding-top:4px;border-top:1px solid var(--line)}}
.sticker-actions{{display:flex;flex-direction:column;align-items:flex-start;gap:8px;max-width:55%}}.sticker-actions input{{max-width:100%;font:inherit}}.sticker-actions output{{font-size:12px;color:var(--muted)}}.sticker-setting{{align-items:flex-start}}
.setting{{display:flex;align-items:center;gap:20px;min-height:62px;padding:10px 0;border-top:1px solid var(--line)}}.setting:first-of-type{{border-top:0}}.setting>span:first-child{{flex:1;min-width:0}}strong,small{{display:block}}small{{margin-top:2px;color:var(--muted)}}.model-row{{gap:12px;overflow:visible}}.model-row button{{flex:none}}.model-picker{{position:relative;width:min(280px,38%);flex:none}}.model-row .model-picker input{{width:100%;padding-right:36px}}.model-picker-toggle{{position:absolute;top:1px;right:1px;bottom:1px;width:32px;padding:0;border:0;border-left:1px solid var(--line);border-radius:0 5px 5px 0;background:var(--bg);color:var(--muted)}}.model-picker-toggle:hover,.model-picker-toggle[aria-expanded="true"]{{background:color-mix(in srgb,var(--accent) 12%,var(--bg));color:var(--text)}}.model-options{{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:1000;max-height:220px;overflow:auto;padding:4px;border:1px solid var(--line);border-radius:7px;background:var(--panel);box-shadow:0 10px 30px #0008}}.model-options[hidden]{{display:none}}.model-option{{display:block;width:100%;padding:7px 9px;border:0;border-radius:5px;background:transparent;color:var(--text);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.model-option:hover,.model-option:focus,.model-option[aria-selected="true"]{{outline:0;background:color-mix(in srgb,var(--accent) 18%,var(--panel))}}.model-option-empty{{padding:8px;color:var(--muted);font-size:12px}}button:disabled{{opacity:.6;cursor:default}}
.field-row input,.field-row select,.textarea-row textarea{{width:min(440px,52%);padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}}.signing-actions{{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;width:min(520px,56%)}}.signing-actions select{{flex:1 1 240px;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}}.field-row input.compact-number{{width:76px;min-width:76px;flex:none;text-align:right;font-variant-numeric:tabular-nums}}.textarea-row textarea{{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
.toggle-row input{{position:absolute;opacity:0;pointer-events:none}}.toggle{{position:relative;width:42px;height:24px;flex:none;border-radius:99px;background:#484f58;transition:.15s}}.toggle:after{{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:white;transition:.15s}}input:checked+.toggle{{background:var(--accent)}}input:checked+.toggle:after{{transform:translateX(18px)}}input:focus-visible+.toggle,.field-row input:focus,.field-row select:focus,.textarea-row textarea:focus{{outline:2px solid var(--accent);outline-offset:2px}}
.actions{{position:sticky;bottom:0;display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:24px;padding:16px;background:color-mix(in srgb,var(--bg) 92%,transparent);border:1px solid var(--line);border-radius:12px;backdrop-filter:blur(12px)}}.save-status{{margin-right:auto;color:var(--muted)}}.save-status.error-state{{color:#ffb3ad}}button{{padding:9px 15px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--text);font:inherit;cursor:pointer}}button.primary{{border-color:var(--accent);background:var(--accent);font-weight:600}}.error{{margin-bottom:16px;padding:12px;border:1px solid var(--danger);border-radius:8px;color:#ffb3ad}}
.settings-layout{{display:grid;grid-template-columns:190px minmax(0,1fr);gap:18px;align-items:start}}.settings-panels{{min-width:0}}.settings-tabs{{position:sticky;top:20px;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}}.settings-tab{{width:100%;padding:9px 10px;border-color:transparent;text-align:left;color:var(--muted);font-weight:600}}.settings-tab:hover{{background:color-mix(in srgb,var(--accent) 8%,var(--panel));color:var(--text)}}.settings-tab[aria-selected="true"]{{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,var(--panel));color:var(--text)}}.settings-tab:focus-visible{{outline:2px solid var(--accent);outline-offset:1px}}
{MESSAGE_BAR_STYLE}
{CODEX_LAYOUT_STYLE}
{WINDOW_TITLE_STYLE}
{COMMIT_HOTKEY_STYLE}
{DIAGNOSTICS_STYLE}
.pack-picker{{margin:12px 0;padding:14px;border:1px solid var(--line);border-radius:10px;min-width:0}}.pack-picker legend{{font-weight:600;padding:0 6px}}.pack-picker>p{{margin:0 0 12px;color:var(--muted)}}.pack-toolbar{{display:flex;align-items:center;gap:12px;margin-bottom:12px}}.pack-toolbar input{{width:100%;min-width:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);font:inherit}}.pack-toolbar output{{white-space:nowrap;color:var(--muted);font-size:12px}}.pack-tabs{{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 8px;scrollbar-width:thin}}.pack-tab{{display:inline-flex;align-items:center;gap:7px;min-width:max-content;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--muted);white-space:nowrap}}.pack-tab strong{{font-size:13px;color:var(--text)}}.pack-tab small{{font-size:11px;color:var(--muted)}}.pack-tab::before{{content:"";width:7px;height:7px;border-radius:50%;background:#484f58;flex:none}}.pack-tab.is-enabled::before{{background:var(--accent)}}.pack-tab[aria-selected="true"]{{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,var(--bg));color:var(--text)}}.pack-tab:focus-visible{{outline:2px solid var(--accent);outline-offset:1px}}.pack-tab[hidden]{{display:none}}.pack-panels{{margin-top:4px}}.pack-panel{{padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}}.pack-panel[hidden]{{display:none}}.pack-panel-head{{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding-bottom:12px;border-bottom:1px solid var(--line)}}.pack-panel-head>span{{min-width:0}}.pack-panel-head strong{{display:block;font-size:14px}}.pack-panel-head small{{display:block;margin-top:4px;color:var(--muted);line-height:1.4}}.pack-enable{{display:flex;align-items:center;gap:7px;flex:none;padding:7px 9px;border:1px solid var(--line);border-radius:7px;cursor:pointer;font-size:12px;font-weight:600}}.pack-enable:has(input:checked){{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--bg))}}.pack-enable input{{accent-color:var(--accent);width:15px;height:15px;margin:0}}.pack-name-heading{{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:12px 0 8px}}.pack-name-heading>span{{font-size:12px;font-weight:600}}.pack-name-heading small{{color:var(--muted);font-size:11px}}.pack-names{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;max-height:250px;overflow:auto;padding:2px}}.pack-name{{display:block;overflow:hidden;text-overflow:ellipsis;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}}#pack-empty{{margin-top:10px}}
@media(max-width:760px){{.settings-header{{flex-wrap:wrap}}.rebuild-actions{{align-items:flex-start}}.rebuild-actions output{{text-align:left}}main{{width:min(100% - 20px,1120px);margin-top:20px}}.settings-layout{{grid-template-columns:1fr}}.settings-tabs{{position:static;display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}.field-row,.textarea-row{{align-items:flex-start;flex-direction:column;gap:8px}}.model-picker{{width:100%}}.field-row input,.field-row select,.textarea-row textarea,.signing-actions{{width:100%}}}}
@media(max-width:460px){{.settings-tabs{{grid-template-columns:1fr}}}}
</style></head><body><main><header class="settings-header"><div><h1>Sweetiebot SCM Setup</h1><p>Configure locally. Settings stay in global Git config or Sweetiebot local files, and signing secrets never enter this page.</p></div><div class="rebuild-actions"><button type="button" id="rebuild-app" title="Manually update and restore Sweetiebot app customizations">Rebuild app</button><output id="rebuild-status" role="status" aria-live="polite"></output></div></header>
{error_html}<form method="post" action="{action}"><div class="settings-layout">
<nav class="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings categories">{''.join(tabs)}</nav>
<div class="settings-panels">{''.join(sections)}</div>
</div>
<div class="actions"><output id="save-status" class="save-status" role="status" aria-live="polite">Saved</output><button class="primary" type="submit" name="action" value="save"{submit_hidden}>{html.escape(submit_label)}</button></div></form>
<script>
{COMMIT_HOTKEY_SCRIPT}
{CODEX_LAYOUT_SCRIPT}
{APP_SCRIPT}
{STICKER_SCRIPT}
{PERMISSIONS_SCRIPT}
{DIAGNOSTICS_SCRIPT}
const settingsForm = document.querySelector('form');
const saveStatus = document.getElementById('save-status');
const commitRequestTimeout = settingsForm.elements.namedItem('aiCommitRequestTimeoutSeconds');
const commitAttempts = settingsForm.elements.namedItem('aiCommitAttempts');
function updateCommitGenerationBudget() {{
  const output = document.getElementById('commit-generation-budget');
  const seconds = Number(commitRequestTimeout.value);
  const attempts = Number(commitAttempts.value);
  output.textContent = commitRequestTimeout.checkValidity() && commitAttempts.checkValidity()
    ? `Overall budget: ${{seconds * attempts}} seconds (${{seconds}} × ${{attempts}}).`
    : 'Enter a valid timeout and attempt count to calculate the overall budget.';
}}
commitRequestTimeout.addEventListener('input', updateCommitGenerationBudget);
commitAttempts.addEventListener('input', updateCommitGenerationBudget);
updateCommitGenerationBudget();
let autosaveTimer = null;
let saveChain = Promise.resolve();
let editVersion = 0;
const finishOnSave = {json.dumps(finish_on_save)};

async function persistSettings() {{
  const version = editVersion;
  saveStatus.textContent = 'Saving…';
  saveStatus.classList.remove('error-state');
  const data = new FormData(settingsForm);
  data.delete('action');
  try {{
    const response = await fetch('/autosave' + location.search, {{
      method: 'POST',
      body: new URLSearchParams(data)
    }});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save settings.');
    if (version === editVersion) saveStatus.textContent = 'Saved';
    return true;
  }} catch (error) {{
    saveStatus.textContent = 'Not saved: ' + error.message;
    saveStatus.classList.add('error-state');
    return false;
  }}
}}

function queueAutosave() {{
  saveChain = saveChain.then(() => persistSettings(), () => persistSettings());
  return saveChain;
}}

function scheduleAutosave(event) {{
  const target = event.target;
  if (!target?.name || target.name === 'action') return;
  editVersion++;
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
    if (await saveChain === false) return;
    if (finishOnSave) HTMLFormElement.prototype.submit.call(settingsForm);
  }});
}}

const rebuildButton = document.getElementById('rebuild-app');
const rebuildStatus = document.getElementById('rebuild-status');
async function pollRebuildStatus() {{
  try {{
    const response = await fetch('/rebuild-status' + location.search, {{cache: 'no-store'}});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to read rebuild status.');
    rebuildButton.disabled = Boolean(result.running);
    rebuildStatus.textContent = result.message || '';
    rebuildStatus.classList.toggle('error-state', Boolean(result.error));
    if (result.running) setTimeout(pollRebuildStatus, 1500);
  }} catch (error) {{
    rebuildButton.disabled = false;
    rebuildStatus.textContent = 'Status unavailable: ' + error.message;
    rebuildStatus.classList.add('error-state');
  }}
}}
rebuildButton?.addEventListener('click', async () => {{
  if (!window.confirm('Update and reinstall Sweetiebot app customizations now? This VS Code window will reload when the rebuild succeeds.')) return;
  rebuildButton.disabled = true;
  rebuildStatus.textContent = 'Saving settings…';
  if (autosaveTimer) {{
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    queueAutosave();
  }}
  if ((await saveChain) === false) {{
    rebuildButton.disabled = false;
    rebuildStatus.textContent = 'Fix unsaved settings before rebuilding.';
    rebuildStatus.classList.add('error-state');
    return;
  }}
  try {{
    const response = await fetch('/rebuild' + location.search, {{method: 'POST'}});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to start rebuild.');
    rebuildStatus.classList.remove('error-state');
    void pollRebuildStatus();
  }} catch (error) {{
    rebuildButton.disabled = false;
    rebuildStatus.textContent = 'Rebuild failed: ' + error.message;
    rebuildStatus.classList.add('error-state');
  }}
}});
void pollRebuildStatus();

async function runLocalSetupAction(path, values = {{}}) {{
  saveStatus.textContent = 'Working…';
  saveStatus.classList.remove('error-state');
  try {{
    const response = await fetch(path + location.search, {{
      method: 'POST',
      body: new URLSearchParams(values)
    }});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to complete local setup.');
    saveStatus.textContent = result.message || 'Done';
    if (result.reload) location.reload();
  }} catch (error) {{
    saveStatus.textContent = 'Setup failed: ' + error.message;
    saveStatus.classList.add('error-state');
  }}
}}

const useSigningKey = document.getElementById('use-signing-key');
const signingKey = document.getElementById('signing-key');
if (useSigningKey && signingKey) {{
  useSigningKey.addEventListener('click', () => {{
    if (signingKey.value) void runLocalSetupAction('/configure-signing-key', {{ fingerprint: signingKey.value }});
  }});
}}
document.getElementById('generate-signing-key')?.addEventListener('click', () => {{
  void runLocalSetupAction('/generate-signing-key');
}});
document.getElementById('open-signing-key-manager')?.addEventListener('click', () => {{
  void runLocalSetupAction('/open-signing-key-manager');
}});

const settingsTabs = [...document.querySelectorAll('.settings-tab')];
const settingsPanels = [...document.querySelectorAll('.settings-panel')];

function activateSettingsCategory(tab, focus = false) {{
  if (!tab) return;
  for (const item of settingsTabs) {{
    const active = item === tab;
    item.setAttribute('aria-selected', active ? 'true' : 'false');
    item.tabIndex = active ? 0 : -1;
  }}
  for (const panel of settingsPanels) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
  if (focus) tab.focus();
}}

for (const tab of settingsTabs) {{
  tab.addEventListener('click', () => activateSettingsCategory(tab));
  tab.addEventListener('keydown', event => {{
    const index = settingsTabs.indexOf(tab);
    let nextIndex = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % settingsTabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = settingsTabs.length - 1;
    else return;
    event.preventDefault();
    activateSettingsCategory(settingsTabs[nextIndex], true);
  }});
}}

{MESSAGE_BAR_SCRIPT}
{WINDOW_TITLE_SCRIPT}

const packSearch = document.getElementById('pack-search');
const packTabs = [...document.querySelectorAll('.pack-tab')];
const packPanels = [...document.querySelectorAll('.pack-panel')];
let activePackId = packTabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.dataset.packId || '';

function packPanel(id) {{
  return packPanels.find(panel => panel.dataset.packId === id);
}}

function activatePack(id, focus = false) {{
  const nextTab = packTabs.find(tab => tab.dataset.packId === id && !tab.hidden);
  if (!nextTab) return;
  activePackId = id;
  for (const tab of packTabs) {{
    const active = tab === nextTab;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }}
  for (const panel of packPanels) panel.hidden = panel.dataset.packId !== id;
  if (focus) nextTab.focus();
}}

function updatePacks() {{
  const query = packSearch.value.trim().toLocaleLowerCase();
  let visible = 0;
  let selected = 0;
  for (const tab of packTabs) {{
    const panel = packPanel(tab.dataset.packId);
    const searchable = (tab.textContent + ' ' + (panel?.textContent || '')).toLocaleLowerCase();
    tab.hidden = !!query && !searchable.includes(query);
    if (!tab.hidden) visible++;
    const checkbox = panel?.querySelector('input[name="branchNamePack"]');
    const enabled = !!checkbox?.checked;
    tab.classList.toggle('is-enabled', enabled);
    if (enabled) selected++;
  }}
  const activeTab = packTabs.find(tab => tab.dataset.packId === activePackId);
  if (!activeTab || activeTab.hidden) {{
    const firstVisible = packTabs.find(tab => !tab.hidden);
    if (firstVisible) activatePack(firstVisible.dataset.packId);
    else for (const panel of packPanels) panel.hidden = true;
  }}
  document.getElementById('pack-count').textContent = `${{selected}} / ${{packTabs.length}} selected`;
  document.getElementById('pack-empty').hidden = visible > 0;
}}

if (packSearch) {{
  packSearch.addEventListener('input', updatePacks);
  for (const tab of packTabs) {{
    tab.addEventListener('click', () => activatePack(tab.dataset.packId));
    tab.addEventListener('keydown', event => {{
      const visibleTabs = packTabs.filter(item => !item.hidden);
      const index = visibleTabs.indexOf(tab);
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % visibleTabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = visibleTabs.length - 1;
      else return;
      event.preventDefault();
      activatePack(visibleTabs[nextIndex].dataset.packId, true);
    }});
  }}
  for (const panel of packPanels) {{
    panel.querySelector('input[name="branchNamePack"]')?.addEventListener('change', updatePacks);
  }}
  updatePacks();
}}

let installedModels = {models_json};
const normalizeModel = name => name.split('/').pop().includes(':') ? name : name + ':latest';
const modelPickers = [...document.querySelectorAll('.model-picker')];

function modelInput(picker) {{
  return picker.querySelector('input[role="combobox"]');
}}

function closeModelPicker(picker) {{
  const input = modelInput(picker);
  const toggle = picker.querySelector('.model-picker-toggle');
  const options = picker.querySelector('.model-options');
  options.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-expanded', 'false');
}}

function focusModelInput(picker) {{
  const input = modelInput(picker);
  if (document.activeElement === input) return;
  picker.dataset.suppressOpen = 'true';
  input.focus();
}}

function renderModelOptions(picker, filter = '') {{
  const input = modelInput(picker);
  const options = picker.querySelector('.model-options');
  const needle = filter.trim().toLocaleLowerCase();
  const matches = installedModels.filter(name => !needle || name.toLocaleLowerCase().includes(needle));
  options.replaceChildren();
  if (!matches.length) {{
    const empty = document.createElement('div');
    empty.className = 'model-option-empty';
    empty.textContent = installedModels.length
      ? 'No installed models match. You can still enter a model tag manually.'
      : 'No installed models. You can still enter a model tag manually.';
    options.append(empty);
  }} else {{
    for (const name of matches) {{
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-option';
      option.setAttribute('role', 'option');
      option.dataset.value = name;
      option.textContent = name;
      option.setAttribute(
        'aria-selected',
        normalizeModel(name) === normalizeModel(input.value.trim()) ? 'true' : 'false'
      );
      options.append(option);
    }}
  }}
}}

function openModelPicker(picker, filter = '') {{
  const input = modelInput(picker);
  const toggle = picker.querySelector('.model-picker-toggle');
  const options = picker.querySelector('.model-options');
  renderModelOptions(picker, filter);
  options.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-expanded', 'true');
}}

function chooseModel(picker, value) {{
  const input = modelInput(picker);
  input.value = value;
  input.dispatchEvent(new Event('input', {{ bubbles: true }}));
  input.dispatchEvent(new Event('change', {{ bubbles: true }}));
  closeModelPicker(picker);
  focusModelInput(picker);
}}

for (const picker of modelPickers) {{
  const input = modelInput(picker);
  const toggle = picker.querySelector('.model-picker-toggle');
  const options = picker.querySelector('.model-options');

  input.addEventListener('focus', () => {{
    if (picker.dataset.suppressOpen) {{
      delete picker.dataset.suppressOpen;
      return;
    }}
    openModelPicker(picker);
  }});
  input.addEventListener('input', () => openModelPicker(picker, input.value));
  input.addEventListener('keydown', event => {{
    if (event.key === 'Escape') {{
      closeModelPicker(picker);
      return;
    }}
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    openModelPicker(picker);
    options.querySelector('.model-option')?.focus();
  }});

  toggle.addEventListener('mousedown', event => event.preventDefault());
  toggle.addEventListener('click', () => {{
    if (options.hidden) {{
      openModelPicker(picker);
      input.focus();
    }} else {{
      closeModelPicker(picker);
      focusModelInput(picker);
    }}
  }});

  options.addEventListener('mousedown', event => event.preventDefault());
  options.addEventListener('click', event => {{
    const option = event.target.closest('.model-option');
    if (option) chooseModel(picker, option.dataset.value);
  }});
  options.addEventListener('keydown', event => {{
    const option = event.target.closest('.model-option');
    if (!option) return;
    const choices = [...options.querySelectorAll('.model-option')];
    const index = choices.indexOf(option);
    if (event.key === 'Enter' || event.key === ' ') {{
      event.preventDefault();
      chooseModel(picker, option.dataset.value);
    }} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {{
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      choices[(index + offset + choices.length) % choices.length]?.focus();
    }} else if (event.key === 'Escape') {{
      event.preventDefault();
      closeModelPicker(picker);
      focusModelInput(picker);
    }}
  }});
}}

document.addEventListener('pointerdown', event => {{
  for (const picker of modelPickers) {{
    if (!picker.contains(event.target)) closeModelPicker(picker);
  }}
}});

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
      for (const picker of modelPickers) {{
        if (!picker.querySelector('.model-options').hidden) renderModelOptions(picker);
      }}
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
const settingsServerInstance = {instance_json};
if (settingsServerInstance) {{
  setInterval(async () => {{
    try {{
      const response = await fetch('/health' + location.search, {{cache: 'no-store'}});
      if (!response.ok) return;
      const status = await response.json();
      if (status.instance && status.instance !== settingsServerInstance) {{
        location.reload();
        return;
      }}
      // Respect in-progress edits while reflecting changes made in VS Code itself.
      if (!autosaveTimer && saveStatus.textContent === 'Saved') {{
        for (const [name, value] of Object.entries(status.windowSettings || {{}})) {{
          const input = settingsForm.elements.namedItem(name);
          if (input && input !== document.activeElement) {{
            if (input.type === 'checkbox' && typeof value === 'boolean') input.checked = value;
            else if (typeof value === 'string') {{
              input.value = value;
              if (name === 'windowHeading') window.refreshHeadingEditor?.(value);
            }}
          }}
        }}
      }}
    }} catch {{
      // The extension may be reloading. Keep the page and retry the same stable URL.
    }}
  }}, 1500);
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
    payload["vscodeSettings"]["pullRequestRefreshIntervalSeconds"] = int(settings["pullRequestRefreshIntervalSeconds"])
    for key in ("mergeSidebarWidthPercent", "mergeTimelineHeightPercent", "mergeRefreshIntervalSeconds", "githubRateLimitCooldownSeconds"):
        payload["vscodeSettings"][key] = int(settings[key])
    return payload


def apply_vscode_settings(current, payload):
    for group, names in VSCODE_SETTINGS.items():
        for key, name in names.items():
            if key in payload.get(group, {}):
                current[name] = payload[group][key]
    if current.get("postCommitAction") not in {"none", "push"}:
        current["postCommitAction"] = "none"


def _result_page(saved: bool) -> str:
    title = "Configuration saved" if saved else "Configuration cancelled"
    detail = "Return to the terminal to continue." if saved else "No settings were changed."
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>body{{margin:0;background:#0d1117;color:#f0f6fc;font:16px system-ui;display:grid;min-height:100vh;place-items:center}}main{{text-align:center;padding:32px}}p{{color:#8b949e}}</style></head><body><main><h1>{title}</h1><p>{detail} You may close this tab.</p></main></body></html>"""


def _manual_rebuild() -> str:
    """Run the explicit installer without changing the automatic-repair preference."""
    root = Path(__file__).resolve().parent
    candidates = (root / "codex-customizations" / "scripts" / "repair.py", root / "repair.py")
    script = next((candidate for candidate in candidates if candidate.is_file()), None)
    if script is None:
        raise RuntimeError("The bundled repair installer is missing.")
    try:
        result = subprocess.run(
            [sys.executable, str(script), "--install"],
            cwd=Path.home(), capture_output=True, text=True, timeout=900, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("The rebuild exceeded 15 minutes. Check the installer logs.") from error
    except OSError as error:
        raise RuntimeError(f"Could not start the repair installer: {error}") from error
    if result.returncode != 0:
        lines = (result.stderr or result.stdout).strip().splitlines()
        detail = lines[-1][:240] if lines else "Check the installer output."
        raise RuntimeError(f"Installer exited with status {result.returncode}: {detail}")
    return "Rebuild complete. Run Developer: Reload Window in VS Code to apply it."


def run_configurator(
    current: dict[str, object],
    action_label: str = "Done",
    *,
    open_browser: bool = True,
    port: int = 0,
    token: str | None = None,
    parent_pid: int | None = None,
    keybindings_file: Path | None = None,
) -> bool:
    token = token or secrets.token_urlsafe(24)
    server_instance = secrets.token_urlsafe(12)
    outcome: dict[str, bool | None] = {"saved": None}
    session_settings = dict(current)
    hotkey_lock = threading.Lock()
    app_lock = threading.Lock()
    rebuild_lock = threading.Lock()
    rebuild_status = {"running": False, "finished": False, "error": False, "message": ""}

    def rebuild_worker() -> None:
        try:
            message = _manual_rebuild()
            failed = False
        except Exception as error:
            message = f"Rebuild failed: {error}"
            failed = True
        with rebuild_lock:
            if not failed and parent_pid is not None:
                message = "Rebuild complete. Reloading this VS Code window…"
            rebuild_status.update(running=False, finished=True, error=failed, message=message)
        if not failed and parent_pid is not None:
            # The owning extension host reloads only its own VS Code window.
            # Failed rebuilds keep the settings page and error visible.
            print(json.dumps({"rebuildComplete": True}), flush=True)

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
            path = urllib.parse.urlsplit(self.path).path
            if path == "/rebuild-status":
                with rebuild_lock:
                    status = dict(rebuild_status)
                self._send_json(status)
                return
            if path == "/health":
                self._send_json({
                    "instance": server_instance,
                    "windowSettings": {
                        name: session_settings.get(name, "")
                        for name in ("windowHeading", "windowName", "windowShowModifiedStatus", "windowShowPushingStatus")
                    },
                })
                return
            if path == "/github-apps":
                self._send_json(app_status())
                return
            if path == "/diagnostics":
                self._send_json(read_diagnostics())
                return
            if path == "/models":
                names, status = fetch_ollama_models()
                self._send_json({"models": names, "status": status})
                return
            names, status = fetch_ollama_models()
            try:
                hotkey = read_commit_hotkey(keybindings_file) if keybindings_file else None
            except (OSError, ValueError):
                hotkey = None
            try:
                codex_hotkey = read_commit_hotkey(
                    keybindings_file, "sweetiebot.commitWithCodex"
                ) if keybindings_file else None
            except (OSError, ValueError):
                codex_hotkey = None
            self._send(render_form(
                session_settings,
                names,
                status,
                token,
                action_label,
                finish_on_save=open_browser,
                server_instance=server_instance,
                commit_hotkey=hotkey,
                codex_commit_hotkey=codex_hotkey,
            ))

        def do_POST(self) -> None:
            if not self._authorized():
                self._send("<h1>Not found</h1>", 404)
                return
            if urllib.parse.urlsplit(self.path).path.startswith("/github-apps/"):
                expected = f"http://127.0.0.1:{self.server.server_port}"
                if self.headers.get("Origin") != expected or self.headers.get("Host") != expected[7:]:
                    self._send_json({"error": "Invalid settings origin."}, 403)
                    return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send("<h1>Invalid request</h1>", 400)
                return
            path = urllib.parse.urlsplit(self.path).path
            max_length = STICKER_UPLOAD_LIMIT if path == "/sticker-upload" else MAX_FORM_BYTES
            if length < 0 or length > max_length:
                self._send_json({"error": "Request too large."}, 413)
                return
            data = self.rfile.read(length)
            if path == "/codex-permissions":
                if parent_pid is None:
                    self._send_json({"error": "Open Magic Settings from VS Code to change Codex permissions."}, 409)
                    return
                print(json.dumps({"codexPermissions": True}), flush=True)
                self._send_json({"opened": True})
                return
            if path == "/sticker-upload":
                # Reject cross-origin requests; the token is required as well.
                origin = self.headers.get("Origin")
                if origin and origin != f"http://127.0.0.1:{self.server.server_port}":
                    self._send_json({"error": "Invalid origin."}, 403)
                    return
                try:
                    codex_sticker.save_sticker(data)
                    self._send_json({"saved": True})
                except (OSError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                return
            if path == "/sticker-reset":
                try:
                    codex_sticker.clear_sticker()
                    self._send_json({"saved": True})
                except (OSError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                return
            values = urllib.parse.parse_qs(data.decode("utf-8"), keep_blank_values=True)
            if urllib.parse.urlsplit(self.path).path == "/sync-window-settings":
                # The live VS Code user configuration is authoritative for these fields.
                names = ("windowHeading", "windowName")
                statuses = ("windowShowModifiedStatus", "windowShowPushingStatus")
                if any(len(values.get(name, [])) != 1 or
                       len(values[name][0]) > 4096 or
                       "\n" in values[name][0] or "\r" in values[name][0]
                       for name in names) or any(values.get(name) not in (["true"], ["false"])
                                                 for name in statuses):
                    self._send_json({"error": "Invalid window settings."}, 400)
                    return
                session_settings.update({name: values[name][0] for name in names})
                session_settings.update({name: values[name][0] == "true" for name in statuses})
                self._send_json({"synced": True})
                return
            if urllib.parse.urlsplit(self.path).path == "/rebuild":
                with rebuild_lock:
                    if rebuild_status["running"]:
                        self._send_json({"error": "A rebuild is already running."}, 409)
                        return
                    rebuild_status.update(running=True, finished=False, error=False, message="Rebuilding Sweetiebot…")
                    threading.Thread(target=rebuild_worker, daemon=True).start()
                self._send_json({"started": True})
                return
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
            path = urllib.parse.urlsplit(self.path).path
            if path.startswith("/github-apps/"):
                try:
                    with app_lock:
                        if path == "/github-apps/save":
                            result = save_app(values)
                        elif path == "/github-apps/mode":
                            result = save_mode(values.get("mode", [""])[0])
                        elif path == "/github-apps/check":
                            result = check_connection(values.get("role", [""])[0], values.get("repository", [""])[0])
                        else:
                            self._send_json({"error": "Unknown App action."}, 404)
                            return
                    self._send_json(result)
                except (RuntimeError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                except Exception:
                    self._send_json({"error": "App setup could not complete. Check local Git and Keychain access."}, 400)
                return
            if path == "/commit-hotkey":
                if not keybindings_file:
                    self._send_json({"error": "Open Settings through VS Code to edit shortcuts."}, 409)
                    return
                try:
                    with hotkey_lock:
                        key = update_commit_hotkey(
                            keybindings_file, values.get("key", [""])[0],
                            values.get("command", ["sweetiebot.commit"])[0],
                        )
                    self._send_json({"saved": True, "key": key})
                except (OSError, RuntimeError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                return
            if path == "/configure-signing-key":
                try:
                    fingerprint = values.get("fingerprint", [""])[0]
                    configured = configure_signing_key(fingerprint)
                    self._send_json({"message": f"Git signing key set to {configured[-16:]}.", "reload": True})
                except (RuntimeError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                return
            if path == "/generate-signing-key":
                try:
                    fingerprint = generate_signing_key()
                    self._send_json({"message": f"Created and selected signing key {fingerprint[-16:]}.", "reload": True})
                except (RuntimeError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                return
            if path == "/open-signing-key-manager":
                try:
                    manager = open_signing_key_manager()
                    self._send_json({"message": f"Opened {manager}.", "reload": False})
                except (RuntimeError, ValueError) as error:
                    self._send_json({"error": str(error)}, 400)
                return
            if path == "/autosave":
                parsed = {}
                try:
                    parsed = parse_submission(values)
                    save_settings(parsed)
                    save_commit_instructions(values.get("commitInstructions", [""])[0])
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
                if open_browser:
                    validate_models(parsed)
                save_settings(parsed)
                save_commit_instructions(values.get("commitInstructions", [""])[0])
            except (RuntimeError, ValueError) as error:
                if not open_browser:
                    self._send_json({"saved": False, "error": str(error)}, 400)
                    return
                names, status = fetch_ollama_models()
                submitted = dict(session_settings)
                submitted.update(parsed)
                self._send(render_form(
                    submitted,
                    names,
                    status,
                    token,
                    action_label,
                    str(error),
                    server_instance=server_instance,
                ), 400)
                return
            session_settings.update(parsed)
            outcome["saved"] = True
            if not open_browser:
                print(json.dumps(extension_settings_payload(parsed)), flush=True)
            if open_browser:
                self._send(_result_page(True))
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self._send_json({"saved": True})

        def log_message(self, _format: str, *_args: object) -> None:
            return

    class SettingsHTTPServer(ThreadingHTTPServer):
        allow_reuse_address = True

    server = SettingsHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{server.server_port}/?token={urllib.parse.quote(token)}"
    if open_browser:
        print(f"Sweetiebot SCM configurator: {url}")
        if not webbrowser.open(url):
            print("Open the URL above in a browser.")
    else:
        print(json.dumps({"url": url}), flush=True)
    stopped = threading.Event()
    if parent_pid:
        def watch_parent():
            while not stopped.wait(1):
                try:
                    os.kill(parent_pid, 0)
                except ProcessLookupError:
                    server.shutdown()
                    return
                except PermissionError:
                    pass
        threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        print("\nConfiguration cancelled.")
    finally:
        stopped.set()
        server.server_close()
    return outcome["saved"] is True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true", help="Send the URL to the calling extension.")
    parser.add_argument("--vscode-settings", help="Current feature preferences supplied by the companion extension.")
    parser.add_argument("--keybindings-file", type=Path, help="VS Code user/profile keybindings.json supplied by the extension.")
    parser.add_argument("--port", type=int, default=0, help="Reuse a stable localhost port for the settings page.")
    parser.add_argument("--token", help="Reuse the settings page authentication token.")
    parser.add_argument("--parent-pid", type=int, help="Stop when the owning extension host exits.")
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
    if args.port < 0 or args.port > 65535:
        parser.error("--port must be between 0 and 65535")
    if args.parent_pid is not None and args.parent_pid <= 0:
        parser.error("--parent-pid must be positive")
    run_configurator(
        current,
        open_browser=not args.no_browser,
        port=args.port,
        token=args.token,
        parent_pid=args.parent_pid,
        keybindings_file=args.keybindings_file,
    )
