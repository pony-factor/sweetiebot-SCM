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

module.exports = { normalizeChatgptProjectUrl, chatgptPromptUrl };
