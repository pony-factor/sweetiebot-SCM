'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runtimeRevision } = require('./runtime_revision');
const { invalidateUserExtensionCache } = require('./extension_cache');
const { reloadBlockReason, rememberAutomaticReload } = require('./reload_guard');

const QUIET_PERIOD_MS = 8000;
const RETRY_DELAYS_MS = [15000, 60000, 300000];

// Repair the app and the selected Codex extension before automatically reloading.
// Extension installs can finish after Sweetie Bot starts, so a repair followed
// by an extension change must be reconciled before reloading the window.
function registerCodexRefresh(vscode, context, beforeReload = async () => {}) {
  if (process.platform !== 'darwin' || vscode.env.remoteName) return;
  const output = vscode.window.createOutputChannel('Sweetie Bot app repair');
  let child, timer, settleTimer, disposed = false, pending = false, reloadRevision;
  let extensionGeneration = 0;
  let focused = vscode.window.state?.focused ?? true;
  let failures = 0;
  let reloadLoopReported = false;
  const loadedRevision = runtimeRevision(vscode, context);
  // A shared stop flag also covers windows using another settings profile.
  const paused = path.join(os.homedir(), '.config', 'sweetiebot', 'pause-app-repair');
  const enabled = () => !fs.existsSync(paused) && vscode.workspace.getConfiguration('scmToolkit').get('automaticAppRepair', true);
  const selectedCodexPath = () => vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;

  const reportReloadBlock = reason => {
    if (reloadLoopReported) return;
    reloadLoopReported = true;
    const message = `Sweetie Bot paused automatic reloads (${reason}). Check Output → Sweetie Bot app repair and reload manually if needed.`;
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
        return;
      }
      failures = 0;
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
    running.stdout.on('data', data => output.append(data.toString()));
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
      if (event.affectsConfiguration('scmToolkit.automaticAppRepair')) schedule(QUIET_PERIOD_MS);
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
  schedule(QUIET_PERIOD_MS);
}

module.exports = { registerCodexRefresh };
