'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function parseArgs(input) {
  const args = JSON.parse(input);
  if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !args[0].trim())
    throw new Error('Enter a JSON array containing an executable and optional string arguments.');
  return args;
}

function localUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('Use an HTTP(S) localhost or loopback URL without credentials.');
  return url.href;
}

function checkoutId(root) {
  return createHash('sha256').update(root).digest('hex');
}

async function openDevelopmentUrl(vscode, url, browser = 'external') {
  if (browser === 'integrated') {
    if (!(await vscode.commands.getCommands(true)).includes('workbench.action.browser.open'))
      throw new Error('This VS Code build does not have the native Integrated Browser.');
    const storage = vscode.workspace.getConfiguration('workbench.browser').get('dataStorage');
    if (!['global', 'workspace'].includes(storage))
      throw new Error('Choose persistent Global or Workspace Integrated Browser storage in VS Code settings first.');
    await vscode.commands.executeCommand('workbench.action.browser.open', { url, openToSide: false });
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function seedBraveProfile(vscode, profile, run = promisify(execFile)) {
  // Never seed or overwrite a profile that already has its own cookie store.
  for (const name of ['Default/Network/Cookies', 'Default/Cookies']) {
    try { await fs.lstat(path.join(profile, name)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const consent = await vscode.window.showWarningMessage(
    'Copy your normal Brave login cookies into this fresh test profile? The unpacked extension may be able to access authenticated sites and sessions according to its permissions. Only continue for code you trust.',
    { modal: true }, 'Copy encrypted cookies', 'Launch without copying');
  if (consent === 'Launch without copying') return;
  if (consent !== 'Copy encrypted cookies') return false;
  // The helper takes a read-only SQLite snapshot locally. Never return cookie
  // contents or subprocess stderr to the extension host or log.
  try {
    await run('python3', [path.join(__dirname, 'seed-brave-profile.py'), profile], { timeout: 20000 });
  } catch {
    throw new Error('Could not seed Brave login cookies. Check that Python 3 and the normal Brave profile are available, or choose a separate sign-in.');
  }
}

function braveArgs(root, profile, url) {
  return ['-na', 'Brave Browser', '--args', '--user-data-dir=' + profile,
    '--disable-extensions-except=' + root, '--load-extension=' + root,
    '--no-first-run', '--no-default-browser-check', '--new-window', url];
}

async function openRegularBrave(vscode, root, url, run = promisify(execFile)) {
  const action = await vscode.window.showQuickPick([
    { label: 'Open test page', description: 'Use the regular Brave profile with this checkout already loaded', kind: 'open' },
    { label: 'Set up checkout in Brave', description: 'Copy the checkout path and open Brave Extensions', kind: 'setup' }
  ], { placeHolder: 'Use your existing Brave settings and sign-ins' });
  if (action?.kind === 'open') {
    await run('/usr/bin/open', ['-a', 'Brave Browser', url]);
  } else if (action?.kind === 'setup') {
    await vscode.env.clipboard.writeText(root);
    await run('/usr/bin/open', ['-a', 'Brave Browser', 'brave://extensions/']);
    vscode.window.showInformationMessage(
      'Checkout path copied. In Brave Extensions, disable the other copy of this extension, then use Load unpacked to select the checkout. Launch the preset again to open the test page.');
  }
}

async function readJson(root, name) {
  try { return JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); }
  catch { return null; }
}

async function suggestedArgs(root) {
  const pkg = await readJson(root, 'package.json');
  if (typeof pkg?.scripts?.dev === 'string') return ['npm', 'run', 'dev'];
  if (typeof pkg?.scripts?.start === 'string') return ['npm', 'start'];
  return ['npm', 'run', 'dev'];
}

async function probe(url) {
  try {
    // Do not follow redirects to non-local addresses or read response bodies.
    const response = await fetch(localUrl(url), {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(1000)
    });
    await response.body?.cancel();
    return true;
  } catch { return false; }
}

async function waitForReady(url, active, { check = probe, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 30 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (!active()) return false;
    if (await check(url)) return active();
    if (i + 1 < attempts) await pause(1000);
  }
  return false;
}

async function chooseRepository(vscode, uri) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) throw new Error('The VS Code Git extension is unavailable.');
  const git = (await extension.activate()).getAPI(1);
  if (uri?.rootUri || uri?.scheme) {
    const selected = git.getRepository(vscode.Uri.from(uri.rootUri ?? uri));
    if (selected) return selected;
  }
  if (git.repositories.length === 1) return git.repositories[0];
  const selected = await vscode.window.showQuickPick(git.repositories.map(repository => ({
    label: path.basename(repository.rootUri.fsPath), description: repository.rootUri.fsPath, repository
  })), { placeHolder: 'Select the checkout to launch' });
  return selected?.repository;
}

function registerDevelopmentLauncher(vscode, context) {
  const pending = new Set();
  const taskName = root => 'Development: ' + path.basename(root) + ' (' + checkoutId(root).slice(0, 12) + ')';
  const running = root => vscode.tasks.taskExecutions.find(execution =>
    execution.task.source === 'Sweetiebot Development' && execution.task.name === taskName(root));

  async function configure(root, existing) {
    const manifest = await readJson(root, 'manifest.json');
    const extension = [2, 3].includes(manifest?.manifest_version);
    const choices = [
      { label: 'Localhost server', kind: 'server', description: 'Run a command and open a local URL when ready' },
      { label: 'Custom process', kind: 'process', description: 'Run a command in a task terminal' }
    ];
    if (process.platform === 'darwin' && extension)
      choices.unshift(
        { label: 'Isolated Brave extension', kind: 'brave', description: 'Load this checkout in a separate browser profile' },
        { label: 'Regular Brave profile', kind: 'brave', braveProfile: 'regular', description: 'Use existing Brave extensions, settings, and sign-ins' }
      );
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a development launch preset' });
    if (!selected) return;
    if (selected.kind === 'brave') {
      const browser = selected.braveProfile === 'regular' ? 'regular' : 'isolated';
      const input = await vscode.window.showInputBox({ prompt: `Page to open in the ${browser} Brave profile`, value: existing?.kind === 'brave' ? existing.url : 'https://chatgpt.com/' });
      if (input === undefined) return;
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP(S) URL without credentials.');
      if (browser === 'regular') return { kind: 'brave', url: url.href, braveProfile: 'regular' };
      const modes = [
        { label: 'Separate sign-in (default)', description: 'Keep the checkout profile independent', copyBraveCookies: false },
        { label: 'Copy normal Brave login cookies', description: 'Seed a fresh profile with website login cookies only', copyBraveCookies: true }
      ];
      const mode = await vscode.window.showQuickPick(modes, {
        placeHolder: existing?.copyBraveCookies ? 'Cookie copying was previously enabled; choose again' : 'Choose how to sign in to the test browser'
      });
      if (!mode) return;
      return { kind: 'brave', url: url.href, copyBraveCookies: mode.copyBraveCookies };
    }
    const value = JSON.stringify(existing?.args ?? await suggestedArgs(root));
    const input = await vscode.window.showInputBox({ prompt: 'Executable and arguments as a JSON array (no shell)', value,
      validateInput: value => { try { parseArgs(value); } catch (error) { return error.message; } } });
    if (input === undefined) return;
    const args = parseArgs(input);
    if (selected.kind === 'process') return { kind: 'process', args };
    const url = await vscode.window.showInputBox({ prompt: 'Local server URL', value: existing?.kind === 'server' ? existing.url : 'http://localhost:5173/',
      validateInput: value => { try { localUrl(value); } catch (error) { return error.message; } } });
    if (url === undefined) return;
    const browsers = [
      { label: 'Default external browser', kind: 'external' },
      { label: 'VS Code Integrated Browser', description: 'Use its existing persistent global/workspace login', kind: 'integrated' }
    ];
    const browser = await vscode.window.showQuickPick(browsers, {
      placeHolder: existing?.browser === 'integrated' ? 'Previously used the Integrated Browser; choose again' : 'Where to open the local server'
    });
    if (!browser) return;
    return { kind: 'server', args, url: localUrl(url), browser: browser.kind };
  }

  async function launch(uri) {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw new Error('Development launch requires a trusted local workspace.');
    const repository = await chooseRepository(vscode, uri);
    if (!repository) return;
    if (repository.rootUri.scheme !== 'file') throw new Error('Select a local checkout.');
    const root = await fs.realpath(repository.rootUri.fsPath);
    if (pending.has(root)) return;
    pending.add(root);
    let locked = true;
    try {
      const remote = repository.state.remotes?.find(item => item.name === 'origin')?.fetchUrl;
      const key = 'developmentLauncher:' + checkoutId(remote || root);
      let config = context.globalState.get(key);
      const current = running(root);
      if (current) {
        const action = await vscode.window.showQuickPick(['Stop task', 'Restart task'], { placeHolder: 'Development process already running' });
        if (!action) return;
        current.terminate();
        if (action === 'Stop task') return;
        for (let i = 0; i < 30 && running(root); i++) await new Promise(resolve => setTimeout(resolve, 100));
        if (running(root)) throw new Error('The previous task is still stopping; try again.');
      } else if (config) {
        const choice = await vscode.window.showQuickPick([
          { label: 'Launch saved preset', description: config.args ? JSON.stringify(config.args) : config.url, kind: 'launch' },
          { label: 'Configure preset', kind: 'configure' }
        ], { placeHolder: 'Launch development environment' });
        if (!choice) return;
        if (choice.kind === 'configure') config = undefined;
      }
      if (!config) {
        config = await configure(root, context.globalState.get(key));
        if (!config) return;
        await context.globalState.update(key, config);
      }
      if (config.kind === 'brave') {
        if (process.platform !== 'darwin' || ![2, 3].includes((await readJson(root, 'manifest.json'))?.manifest_version))
          throw new Error('The Brave preset requires a macOS browser-extension checkout.');
        if (config.braveProfile === 'regular') {
          await openRegularBrave(vscode, root, config.url);
          return;
        }
        const profile = path.join(context.globalStorageUri.fsPath, 'brave-tests', checkoutId(root));
        await fs.mkdir(profile, { recursive: true, mode: 0o700 });
        if (config.copyBraveCookies === true && await seedBraveProfile(vscode, profile) === false) return;
        await promisify(execFile)('/usr/bin/open', braveArgs(root, profile, config.url));
        return;
      }
      const args = parseArgs(JSON.stringify(config.args));
      const url = config.kind === 'server' ? localUrl(config.url) : undefined;
      if (url && await probe(url)) throw new Error('The configured URL already responds. Stop the existing server or choose another port before launching.');
      const folder = vscode.workspace.getWorkspaceFolder(repository.rootUri);
      if (!folder) throw new Error('Open the selected checkout in the current workspace before launching.');
      const task = new vscode.Task({ type: 'sweetiebot-development', checkout: root }, folder, taskName(root),
        'Sweetiebot Development', new vscode.ProcessExecution(args[0], args.slice(1), { cwd: root }));
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
      const execution = await vscode.tasks.executeTask(task);
      if (!url) return;
      // Allow the same button to stop or restart this task during readiness.
      pending.delete(root);
      locked = false;
      const ready = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Waiting for ' + url, cancellable: true
      }, (_, token) => waitForReady(url, () => !token.isCancellationRequested && running(root) === execution));
      if (ready && running(root) === execution) await openDevelopmentUrl(vscode, url, config.browser);
      else vscode.window.showInformationMessage('Server URL was not ready before the wait ended. Check the development task terminal.');
    } finally { if (locked) pending.delete(root); }
  }

  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.launchDevelopment', uri =>
    launch(uri).catch(error => vscode.window.showErrorMessage('Development launch: ' + error.message))));
}

module.exports = { parseArgs, localUrl, checkoutId, braveArgs, suggestedArgs, waitForReady, openDevelopmentUrl, openRegularBrave, seedBraveProfile, registerDevelopmentLauncher };
