'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runtimeRevision } = require('../ui/runtime-revision');
const { invalidateUserExtensionCache } = require('../ui/extension-cache');
const { reloadBlockReason, rememberAutomaticReload } = require('../ui/reload-guard');

const QUIET_PERIOD_MS = 8000;
const RETRY_DELAYS_MS = [15000, 60000, 300000];

// Repair the app and the selected Codex extension before automatically reloading.
// Extension installs can finish after Sweetiebot starts, so a repair followed
// by an extension change must be reconciled before reloading the window.
function registerCodexRefresh(vscode, context, beforeReload = async () => {}) {
  if (process.platform !== 'darwin' || vscode.env.remoteName) return;
  const output = vscode.window.createOutputChannel('Sweetiebot app repair');
  let child, timer, settleTimer, disposed = false, pending = false, reloadRevision;
  let extensionGeneration = 0;
  let focused = vscode.window.state?.focused ?? true;
  let failures = 0;
  let reloadLoopReported = false;
  const loadedRevision = runtimeRevision(vscode, context);
  // A shared stop flag also covers windows using another settings profile.
  const paused = path.join(os.homedir(), '.config', 'sweetiebot', 'pause-app-repair');
  const enabled = () => !fs.existsSync(paused) && vscode.workspace.getConfiguration('sweetiebot').get('automaticAppRepair', true);
  const selectedCodexPath = () => vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
  const restartState = context.globalState || context.workspaceState;
  const restartKey = 'sweetiebot.browserProfileRestart';
  const appPid = process.env.VSCODE_PID;
  let restartReported = false;
  const reportBrowserRestart = () => {
    if (restartReported || disposed) return;
    restartReported = true;
    const message = 'Sweetiebot restored the shared browser profile. Fully quit and reopen VS Code to use your saved site sign-ins; Reload Window cannot restart the browser process.';
    output.appendLine(message);
    void vscode.window.showWarningMessage?.(message);
  };
  if (appPid && restartState?.get(restartKey) === appPid) reportBrowserRestart();

  const reportReloadBlock = reason => {
    if (reloadLoopReported) return;
    reloadLoopReported = true;
    const message = `Sweetiebot: Automatic reloads paused (${reason}). Check Output → Sweetiebot app repair and reload manually if needed.`;
    output.appendLine(message);
    void vscode.window.showWarningMessage?.(message);
  };

  const reload = revision => {
    if (!revision || revision === loadedRevision || revision === reloadRevision || disposed || !enabled() || !focused) return;
    const blocked = reloadBlockReason(context, revision);
    if (blocked) {
      reportReloadBlock(blocked);
      return;
    }
    reloadRevision = revision;
    void (async () => {
      await beforeReload();
      if (disposed || !enabled() || !focused) {
        reloadRevision = undefined;
        return;
      }
      // Files may change while the settings server stops; avoid reloading
      // for a revision that has already been superseded.
      if (runtimeRevision(vscode, context) !== revision) {
        reloadRevision = undefined;
        schedule(QUIET_PERIOD_MS);
        return;
      }
      const newerBlock = reloadBlockReason(context, revision);
      if (newerBlock) {
        reloadRevision = undefined;
        reportReloadBlock(newerBlock);
        return;
      }
      // Preserve only the active Codex conversation ID in that webview's VS Code
      // state. This is best-effort; a missing/closed Codex view must not prevent
      // an otherwise safe application update.
      try {
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes('sweetiebot.preserveCodexConversation')) {
          await vscode.commands.executeCommand('sweetiebot.preserveCodexConversation');
        }
      } catch (error) {
        output.appendLine('Codex conversation could not be preserved: ' + error.message);
      }
      if (disposed || !enabled() || !focused || runtimeRevision(vscode, context) !== revision) {
        reloadRevision = undefined;
        return;
      }
      // Persist before reload: the next activation loses in-memory state.
      await rememberAutomaticReload(context, revision);
      invalidateUserExtensionCache(context, output);
      output.appendLine('Reloading this window to apply Sweetiebot updates.');
      return vscode.commands.executeCommand('workbench.action.reloadWindow');
    })().catch(error => {
      reloadRevision = undefined;
      output.appendLine(error.message);
    });
  };

  const schedule = (delay = 2000) => {
    clearTimeout(timer);
    clearTimeout(settleTimer);
    if (!disposed && enabled()) timer = setTimeout(refresh, delay);
  };

  const refresh = () => {
    if (disposed || !enabled()) return;
    if (child) { pending = true; return; }
    const codexPath = selectedCodexPath();
    const generation = extensionGeneration;
    const script = vscode.Uri.joinPath(context.extensionUri,
      'codex-customizations', 'scripts', 'repair.py').fsPath;
    const args = [script, '--app', path.resolve(vscode.env.appRoot, '../../..')];
    if (codexPath) args.push('--codex-extension', codexPath);
    child = spawn('python3', args, {
      cwd: context.extensionPath,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const running = child;
    let finished = false, timedOut = false;
    let coreRepaired = false, outputTail = '';
    const timeout = setTimeout(() => {
      timedOut = true;
      output.appendLine('Automatic repair timed out; it will retry later.');
      running.kill();
    }, 90000);
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child = undefined;
      if (disposed) return;
      if (code === 75 && !timedOut) {
        pending = false;
        schedule(QUIET_PERIOD_MS);
        return;
      }
      if (code !== 0 || timedOut) {
        output.appendLine('Repair did not complete. Check the error above; macOS App Management permission or support for this app version may be required.');
      }
      // A new extension version may have landed while Python was running.
      // In that case, repair the newly selected extension before any reload.
      if (pending || extensionGeneration !== generation || selectedCodexPath() !== codexPath) {
        pending = false;
        schedule(QUIET_PERIOD_MS);
        return;
      }
      if (code !== 0 || timedOut) {
        if (failures < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[failures++];
          output.appendLine(`Retrying automatic repair in ${delay / 1000} seconds.`);
          schedule(delay);
        }
        // A later release/optional patch failure cannot strand the core UI
        // that the local preflight successfully restored.
        if (!coreRepaired) return;
      }
      if (code === 0 && !timedOut) failures = 0;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (disposed || !enabled()) return;
        if (child || pending || extensionGeneration !== generation || selectedCodexPath() !== codexPath) {
          schedule(QUIET_PERIOD_MS);
          return;
        }
        reload(runtimeRevision(vscode, context));
      }, QUIET_PERIOD_MS);
    };
    running.stdout.on('data', data => {
      const message = data.toString();
      output.append(message);
      outputTail += message;
      if (outputTail.includes('Sweetiebot core repair complete.')) coreRepaired = true;
      if (outputTail.includes('Browser session changes require a full VS Code quit and restart')) {
        if (appPid) void Promise.resolve(restartState?.update(restartKey, appPid)).catch(error => {
          output.appendLine('Could not remember the browser restart notice: ' + error.message);
        });
        reportBrowserRestart();
      }
      outputTail = outputTail.slice(-256);
    });
    running.stderr.on('data', data => output.append(data.toString()));
    running.on('error', error => { output.appendLine(error.message); finish(-1); });
    running.on('close', finish);
  };

  const interval = setInterval(() => { failures = 0; schedule(QUIET_PERIOD_MS); }, 60 * 60 * 1000);
  context.subscriptions.push(output, vscode.extensions.onDidChange(() => {
    extensionGeneration++;
    failures = 0;
    schedule(QUIET_PERIOD_MS);
  }),
    vscode.window.onDidChangeWindowState(event => {
      focused = event.focused;
      if (event.focused && enabled() && runtimeRevision(vscode, context) !== loadedRevision) {
        schedule(QUIET_PERIOD_MS);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('sweetiebot.automaticAppRepair') ||
          event.affectsConfiguration('sweetiebot.sourceControlLabel') ||
          event.affectsConfiguration('sweetiebot.messageBarLayout')) schedule(QUIET_PERIOD_MS);
    }), {
      dispose() {
        disposed = true;
        clearInterval(interval);
        clearTimeout(timer);
        clearTimeout(settleTimer);
        child?.kill();
      }
    });
  // Allow startup extension discovery and pending installs to settle first.
  if (fs.existsSync(paused)) {
    const message = 'Sweetiebot automatic repair is paused by a shared stop flag. App updates cannot restore the SCM controls or saved browser profile while it is paused.';
    output.appendLine(message);
    void Promise.resolve(vscode.window.showWarningMessage?.(message, 'Resume automatic repair')).then(async choice => {
      if (choice !== 'Resume automatic repair' || disposed) return;
      try {
        try { fs.unlinkSync(paused); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await vscode.workspace.getConfiguration('sweetiebot').update('automaticAppRepair', true, vscode.ConfigurationTarget.Global);
        schedule(QUIET_PERIOD_MS);
      } catch (error) {
        output.appendLine('Could not resume automatic repair: ' + error.message);
      }
    });
  }
  schedule(QUIET_PERIOD_MS);
}

module.exports = { registerCodexRefresh };
