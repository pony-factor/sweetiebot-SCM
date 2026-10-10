'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { runtimeRevision } = require('./runtime_revision');
const { invalidateUserExtensionCache } = require('./extension_cache');

const QUIET_PERIOD_MS = 8000;

// Repair the app and the selected Codex extension before offering one reload.
// Extension installs can finish after Sweetie Bot starts, so a repair followed
// by an extension change must be reconciled before showing the notification.
function registerCodexRefresh(vscode, context, beforeReload = async () => {}) {
  if (process.platform !== 'darwin' || vscode.env.remoteName) return;
  const output = vscode.window.createOutputChannel('Sweetie Bot app repair');
  let child, timer, settleTimer, disposed = false, pending = false, offeredRevision;
  let extensionGeneration = 0;
  const loadedRevision = runtimeRevision(vscode, context);
  const enabled = () => vscode.workspace.getConfiguration('scmToolkit').get('automaticAppRepair', true);
  const selectedCodexPath = () => vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;

  const offerReload = revision => {
    if (!revision || revision === loadedRevision || revision === offeredRevision || disposed || !enabled()) return;
    offeredRevision = revision;
    void vscode.window.showInformationMessage(
      'Sweetiebot update ready',
      'Reload Window'
    ).then(async choice => {
      if (!disposed && choice === 'Reload Window') {
        await beforeReload();
        if (!disposed) return vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }).catch(error => {
      offeredRevision = undefined;
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
      // In that case, repair the newly selected extension before any prompt.
      if (pending || extensionGeneration !== generation || selectedCodexPath() !== codexPath) {
        pending = false;
        schedule(QUIET_PERIOD_MS);
        return;
      }
      if (code !== 0 || timedOut) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (disposed || !enabled()) return;
        if (child || pending || extensionGeneration !== generation || selectedCodexPath() !== codexPath) {
          schedule(QUIET_PERIOD_MS);
          return;
        }
        const revision = runtimeRevision(vscode, context);
        if (revision !== loadedRevision && revision !== offeredRevision) {
          // VS Code caches user extension manifests across reloads. Invalidate its
          // disposable scan cache before our single reload, so a changed companion
          // manifest does not trigger a second native reload notification.
          invalidateUserExtensionCache(context, output);
        }
        offerReload(revision);
      }, QUIET_PERIOD_MS);
    };
    running.stdout.on('data', data => output.append(data.toString()));
    running.stderr.on('data', data => output.append(data.toString()));
    running.on('error', error => { output.appendLine(error.message); finish(-1); });
    running.on('close', finish);
  };

  const interval = setInterval(() => schedule(QUIET_PERIOD_MS), 60 * 60 * 1000);
  context.subscriptions.push(output, vscode.extensions.onDidChange(() => {
    extensionGeneration++;
    schedule(QUIET_PERIOD_MS);
  }),
    vscode.window.onDidChangeWindowState(event => {
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
