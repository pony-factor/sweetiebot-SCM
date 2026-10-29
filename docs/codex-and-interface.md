# Codex, Integrated Browser and workbench UI

Sweetiebot patches selected **VS Code workbench** components and supported **Codex** webview/composer elements. A setting can exist even when a particular VS Code/Codex release lacks a compatible patch anchor; the installer must reject unsupported changes safely.

## Codex controls

[Codex assets](../assets/codex/) cover optional composer layouts, queued prompts/edits, attachment drop handling, permissions icon, usage/reset displays and countdowns, chat labels/timestamps, dictation/promotions, Send-wing icon, and macOS **Keep awake while Codex works**. The latter is `scmToolkit.codexKeepAwake=true` by default; it releases wake protection when relevant tasks finish. This is not a promise an offline Mac or remote service will keep working.

Some controls are purely visual: a wing replaces Send and a mirrored wing replaces Stop when enabled, without changing Queue/Stop semantics; rate-limit indicators do not change quotas. A queued draft or usage estimate is not a remote API authorization.

## Composer layout

The Codex tab of Sweetiebot setup now has a drag-and-drop composer layout editor, patterned after the SCM message bar. It orders the input, attachment/usage, permissions, location, clipboard Send/Queue, and Send/Stop controls. Send/Stop shares a slot, and the Pegasus wing setting controls only its appearance. The input cannot be hidden. Hidden controls appear in **More composer controls** to reveal and invoke the original native button, preserving Codex ownership. Settings require app repair/reload; absent upstream controls are untouched and legacy toggles remain compatible.

## Workbench and browser

[Workbench assets](../assets/workbench/) implement Source Control message controls, branch picker, title-bar actions, layout tweaks and selective live patch replacement. [Browser assets](../assets/browser/) support PR handoffs and optional integration bridges. Local settings and browser callbacks must not expose App PEMs, GitHub access tokens or untrusted repository data to an arbitrary webpage.

After VS Code/Codex updates, run `python3 scripts/install.py --check`, inspect **Output → Sweetie Bot app repair**, and manually test toggles before treating the UI as compatible. Availability depends on upstream DOM and workspace permissions.

Source/test entry points: [installer](../scripts/install.py), [picker](../assets/workbench/picker.js), [Codex queued edits](../assets/codex/queued-edit.js), [Codex usage](../assets/codex/usage.js), [browser regressions](../tests/codex_webview_browser.py). See [installation](installation-and-repair.md).
