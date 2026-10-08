'use strict';

// ChatGPT project paths scope new chats to the project's instructions and files.
// A blank setting retains Sweetie Bot's existing ordinary ChatGPT destination.
const PROJECT_PATH = /^\/g\/g-p-[A-Za-z0-9-]+\/project\/?$/;

function normalizeChatgptProjectUrl(value) {
  const configured = String(value ?? '').trim();
  if (!configured) return '';
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('ChatGPT project URL must be a complete https://chatgpt.com/g/g-p-.../project link.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port ||
      url.username || url.password || url.search || url.hash || !PROJECT_PATH.test(url.pathname)) {
    throw new Error('ChatGPT project URL must be a complete https://chatgpt.com/g/g-p-.../project link.');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

function chatgptPromptUrl(prompt, configuredProjectUrl = '') {
  const destination = normalizeChatgptProjectUrl(configuredProjectUrl) || 'https://chatgpt.com/';
  return destination + '?q=' + encodeURIComponent(prompt);
}


const REGULAR_CHAT_CHOICE_KEY = 'scmToolkit.useRegularChatForWebActions';

// ChatGPT does not expose a supported API for creating personal projects.
// The user creates or chooses an unshared project in ChatGPT and copies its URL.
// Never silently launch an action into a general chat when setup is cancelled.
async function resolveChatgptActionProject(vscode, context) {
  const configuration = vscode.workspace.getConfiguration('scmToolkit');
  const configured = configuration.get('chatgptProjectUrl', '');
  if (configured) return normalizeChatgptProjectUrl(configured);
  // Keep legacy callers and isolated command tests usable without state.
  if (!context?.globalState || context.globalState.get(REGULAR_CHAT_CHOICE_KEY, false)) return '';

  const choice = await vscode.window.showInformationMessage(
    'Keep Sweetie Bot pull-request and merge chats together in a private ChatGPT project, rather than your main chat history.',
    { modal: true },
    'Set up project',
    'Use regular chats'
  );
  if (choice === 'Use regular chats') {
    await context.globalState.update(REGULAR_CHAT_CHOICE_KEY, true);
    return '';
  }
  if (choice !== 'Set up project') return undefined;

  // Open in the external browser: an open VS Code input box must not prevent
  // the user from creating or navigating to their project.
  await vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/'));
  const value = await vscode.window.showInputBox({
    title: 'Sweetie Bot web-action project',
    prompt: 'In ChatGPT, create or open an unshared project. Copy its /g/g-p-.../project URL and paste it here. Sweetie Bot cannot create or verify a private project for you.',
    placeHolder: 'https://chatgpt.com/g/g-p-.../project',
    ignoreFocusOut: true,
    validateInput(text) {
      try {
        if (!String(text || '').trim()) return 'Paste a ChatGPT project URL, or press Escape to cancel.';
        normalizeChatgptProjectUrl(text);
        return undefined;
      } catch (error) {
        return error.message;
      }
    }
  });
  if (value === undefined) return undefined;
  const projectUrl = normalizeChatgptProjectUrl(value);
  if (!projectUrl) return undefined;
  await configuration.update('chatgptProjectUrl', projectUrl, vscode.ConfigurationTarget.Global);
  await context.globalState.update(REGULAR_CHAT_CHOICE_KEY, false);
  return projectUrl;
}

module.exports = { normalizeChatgptProjectUrl, chatgptPromptUrl, resolveChatgptActionProject };
